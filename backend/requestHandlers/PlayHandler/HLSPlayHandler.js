/**
 * Created by owenray on 08-04-16.
 */
"use strict";
var spawn = require('child_process').spawn;
var os = require('os');
var fs = require("fs");
var url = require("url");
var Settings = require("../../Settings");
var FFProbe = require("../../FFProbe");
var uuid = require('node-uuid');

var MediaItemHelper = require("../../helpers/MediaItemHelper");
var Debug = require("../../helpers/Debug");
var IPlayHandler = require("./IPlayHandler");
var FileRequestHandler = require("../FileRequestHandler");
const Duplex = require('stream').Duplex;

class HLSPlayHandler extends IPlayHandler{
    play(mediaItem, offset, request, response)
    {
        this.request = request;
        this.response = response;
        var u = url.parse(offset, true);

        if(u.query.format!="hls"&&
            (request.headers["user-agent"].indexOf("Chrome")!==-1||
            request.headers["user-agent"].indexOf("Safari")===-1)) {
            return false;
        }
        if(request.headers["x-playback-session-id"]&&!u.query.session) {
            u.query.session = request.headers["x-playback-session-id"];
        }

        this.offset = u.pathname;
        if(!u.query||!u.query.session||!HLSPlayHandler.sessions[u.query.session]) {
            Debug.debug("STARTING NEW HLS SESSION!!!");
            //this.response.statusCode=302;
            var id = u.query.session?u.query.session:uuid.v4();
            this.session = id;
            var redirectUrl = "/ply/"+mediaItem.id+"/0?format=hls&session="+id;
            Debug.debug("started hls session", redirectUrl);
            // this.response.setHeader("Location", redirectUrl);
            HLSPlayHandler.sessions[id] = this;
            this.setSessionTimeout();
            this.response.setHeader("Content-Type", "application/x-mpegURL");

            this.response.end("#EXTM3U\n"+
                              "#EXT-X-STREAM-INF:PROGRAM-ID=1, BANDWIDTH=200000, RESOLUTION=720x480\n"+
                              redirectUrl);
        }else{
            HLSPlayHandler.sessions[u.query.session].newRequest(request, response, u.query.segment);
            return true;
        }

        var dir = os.tmpdir()+"/remote_cache";
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir);
        }
        dir+="/"+this.session+"/";
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir);
        }
        this.m3u8 = dir+"vid.m3u8";
        this.file = MediaItemHelper.getFullFilePath(mediaItem);
        Debug.debug("starting to play:"+this.file);
        FFProbe.getInfo(this.file).then(this.gotInfo.bind(this), this.onError.bind(this));
        return true;
    }

    /**
     * timeout sessions and cleanup disk when sessions are no longer in use
     */
    setSessionTimeout() {
        if(this.sessionTimeout) {
            clearTimeout(this.sessionTimeout);
        }
        //session will time out after 2 minutes of no activity
        this.sessionTimeout = setTimeout(this.timedOut.bind(this), 120000);
    }

    timedOut() {
        if(this.proc)
            this.proc.kill();
        Debug.debug("session timeout!");
        this.onClose(0);

        //clean up filesystem
        var parts = this.m3u8.split("/");
        parts.pop();
        var folder = parts.join("/");
        fs.readdir(folder, (err, files) => {
            var deleteNext = function(){
                if(files.length==0)
                    return fs.rmdir(folder, function(){});
                fs.unlink(files.pop(), deleteNext);
            }
            deleteNext();
        });
    }

    newRequest(request, response, segment) {
        this.setSessionTimeout();

        if(segment) { //serve ts file
            response.setHeader('Accept-Ranges', 'none');
            var file = os.tmpdir() + "/remote_cache/" + this.session + "/" + segment;
            Debug.debug("return hls");
            if(!this.playStart) { //set the play start time when serving first ts file
                this.playStart = new Date().getTime();
            }
            return new FileRequestHandler(request, response)
                .serveFile(file, true);
        }

        if (!this.paused) {
            setTimeout(function() {
                this.newRequest(request, response, segment);
            }.bind(this), 1000);
            return;
        }
        /*if(!this.hlsHasBeenServed) {
            this.serveFirstThree(response);
        }else{
            new FileRequestHandler(request, response).serveFile(this.m3u8);
        }*/
        this.serveFirstHls(response);
    }

    /**
     * @param response
     *
     * Make sure the first hls that's requested has no more then three chunks
     * this is to ensure the browser will not skip any chunks
     */
    serveFirstHls(response) {
        response.setHeader("Content-Type", "application/x-mpegURL");

        fs.readFile(this.m3u8, function(err, data){
            if(err) {
                return response.end();
            }
            var currentTime = this.playStart?(new Date().getTime()-this.playStart)/1000:0;
            var segmentTime = 0;

            var lines = `${data}`.split("\n");
            var newSegments = 0;
            for(var c = 0; c<lines.length; c++) {
                response.write(lines[c]+"\n");
                if(lines[c][0]!="#"&&segmentTime>=currentTime) {
                    newSegments++;
                }else{
                    var ext = lines[c].substring(1).split(":");
                    if(ext[0]=="EXTINF") {
                        segmentTime+=parseFloat(ext[1]);
                    }
                }
                if(newSegments==(!this.playStart?3:5)) {
                    break;
                }
            }
            return response.end();
        }.bind(this));
    }

    gotInfo(info, correctedOffset)
    {
        if(this.ended)
            return;
        if(!correctedOffset&&this.offset!=0)
        {
            FFProbe.getNearestKeyFrame(this.file, this.offset)
                .then(
                    function(offset){
                        //this.offset = offset;
                        this.offset = offset;
                        Debug.debug("play from 2:", offset);
                        this.gotInfo(info, true);
                    }.bind(this),
                    this.onError.bind(this)
                );
            return;
        }
        if(!info||!info.format)
        {
            Debug.warning("VIDEO ERROR!:", info);
            this.response.end();
            return;
        }

        var vCodec = "libx264";
        var aCodec = "aac";

        var supportedVideoCodecs = {"h264":1};
        var supportedAudioCodecs = {"aac":1};


        for(var key in info.streams)
        {
            var stream = info.streams[key];
            if(stream.codec_type=="video"&&supportedVideoCodecs[stream.codec_name])
            {
                vCodec = "copy";
            }
            if(stream.codec_type=="audio"&&supportedAudioCodecs[stream.codec_name])
            {
                aCodec = "copy";
            }
        }
        var duration = Math.round((info.format.duration-this.offset)*1000);
        Debug.debug("setDuration", duration);

        // om keyframe te vinden, gaat wellicht veel fixen:
        // ffprobe.exe -read_intervals 142%+#1  -show_frames -select_streams v:0 -print_format json  "//home/nzbget/downloads/complete/MoviesComplete\Hitman Agent 47 2015 BluRay 720p DTS-ES x264-ETRG\Hitman Agent 47 2015 BluRay 720p DTS x264-ETRG.mkv" | grep pts_time
        var args = [
            //"-re", // <-- should read the file at running speed... but a little to slow...
            "-probesize", "50000000",
            "-thread_queue_size", "1024",
            "-i", this.file,

            "-stdin",
            "-vcodec", vCodec,
            "-hls_time", 5,
            "-hls_list_size", 0,
            "-hls_base_url", this.request.url.split("?")[0]
                             + "?format=hls&session="+this.session+"&segment=",
            "-bsf:v", "h264_mp4toannexb",
            "-acodec", aCodec,
            "-sn",
            "-strict", "-2",
            this.m3u8

        ];
        if(aCodec!="copy")
        {
            Debug.debug("mixing down to 2 AC!");
            args.splice(19, 0, "-ac", 2, "-ab", "192k");
        }
        if(this.offset!=0) {
            args.splice(6, 0, "-ss", 0);
            args.splice(4, 0, "-ss", this.offset);
        }
        Debug.info("starting ffmpeg:"+Settings.getValue("ffmpeg_binary")+" "+args.join(" "));
        var str = fs.createWriteStream(null, { fd: 4 });
        var proc = spawn(
            Settings.getValue("ffmpeg_binary"),
            args,
            {
                "stdio":["pipe", null, "pipe", this.str]
            });
        this.proc = proc;
        proc.on("error", this.onError.bind(this));

        proc.stdout.on('data', this.onInfo.bind(this));
        /*setTimeout(function() {
            console.log("pause stdout");
            console.log("write1", proc.stdin.write("c", function(){
                console.log("written?", arguments);
            }));
            //proc.stdin.end();
            //proc.stdin.pause();
        }, 6000);*/
        proc.stderr.on('data', this.onError.bind(this));
        proc.on('close', this.onClose.bind(this));
        this.checkPause();
        this.checkPauseInterval = setInterval(this.checkPause.bind(this), 100);
    }

    /**
     * pauses the video encoding process when there are enough chunks available
     */
    checkPause() {
        fs.readdir(os.tmpdir() + "/remote_cache/" + this.session + "/", function(err, files){
            if(err)
                return;
            var count = 0;
            var limit = 10;
            if(files.length>limit&&!this.paused) {
                this.paused = true;
                this.proc.stdin.write("c");
            }else if(files.length<=limit&&this.paused) {
                this.paused = false;
                this.proc.stdin.write("\n");
            }

        }.bind(this));
    }

    onInfo(data)
    {
        //Debug.warning("ffmpeg:"+`${data}`);
    }

    onError(data)
    {
        Debug.debug("ffmpeg:"+`${data}`);
    }

    onClose(code)
    {

        clearInterval(this.checkPauseInterval);
        HLSPlayHandler.sessions[this.session] = null;
        this.ended = true;
    }
}

HLSPlayHandler.sessions = [];

module.exports = HLSPlayHandler;
