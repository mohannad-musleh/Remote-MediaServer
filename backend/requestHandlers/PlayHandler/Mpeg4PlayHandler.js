/**
 * Created by owenray on 08-04-16.
 */
"use strict";
var spawn = require('child_process').spawn;
var os = require('os');
var fs = require("fs");
var Settings = require("../../Settings");
var FFProbe = require("../../FFProbe");

var MediaItemHelper = require("../../helpers/MediaItemHelper");
var Debug = require("../../helpers/Debug");
var IPlayHandler = require("./IPlayHandler");

class Mpeg4PlayHandler extends IPlayHandler{
    play(mediaItem, offset, request, response)
    {
        this.offset = offset;
        console.log("mp4?");
        this.response = response;
        this.request = request;
        this.file = MediaItemHelper.getFullFilePath(mediaItem);
        Debug.debug("starting to play:"+this.file);
        console.log(this.file);
        FFProbe.getInfo(this.file).then(this.gotInfo.bind(this), this.onError.bind(this));
    }

    gotInfo(info, correctedOffset)
    {
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
            Debug.warning("VIDEO ERROR!");
            this.response.end();
            return;
        }
        this.response.setHeader('Content-Type', "video/mp4");
        this.response.setHeader('Accept-Ranges', 'none');

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
        //OK... this is a hack to specify the video duration...
        this.tmpFile = os.tmpdir()+"/"+Math.random()+".txt";
        var metadata = ";FFMETADATA1\n"+
            "[CHAPTER]\n"+
            "TIMEBASE=1/1000\n"+
            //"START=0\n"+
            "END="+duration+"\n"+
            "title=chapter \#1\n";

        fs.writeFileSync(this.tmpFile, metadata);

        // om keyframe te vinden, gaat wellicht veel fixen:
        // ffprobe.exe -read_intervals 142%+#1  -show_frames -select_streams v:0 -print_format json  "//home/nzbget/downloads/complete/MoviesComplete\Hitman Agent 47 2015 BluRay 720p DTS-ES x264-ETRG\Hitman Agent 47 2015 BluRay 720p DTS x264-ETRG.mkv" | grep pts_time
        var args = [
            //"-re", // <-- should read the file at running speed... but a little to slow...
            "-probesize", "50000000",
            "-thread_queue_size", "1024",
            //"-ss", this.offset,
            "-i", this.file,
            "-i", this.tmpFile,
            //"-ss", 0,
            "-map_metadata", "1",
            //"-af", "aresample=60000",
            //"-keyint_min", "60", "-g", "60",
            //"-r", "25",

            "-f", "mp4",
            "-vcodec", vCodec,
            "-movflags", "empty_moov",
            "-acodec", aCodec,
            //"-metadata:c:0", 'end=120000',
            "-strict", "-2",
            "-"
        ];
        if(aCodec!="copy")
        {
            Debug.debug("mixing down to 2 AC!");
            args.splice(18, 0, "-ac", 2, "-ab", "192k");
        }
        if(this.offset!=0) {
            args.splice(8, 0, "-ss", 0);
            args.splice(4, 0, "-ss", this.offset);
        }
        Debug.info("starting ffmpeg:"+Settings.getValue("ffmpeg_binary")+" "+args.join(" "));
        var proc = spawn(
            Settings.getValue("ffmpeg_binary"),
            args);
        this.proc = proc;

        proc.stdout.on('data', this.onData.bind(this));
        proc.stderr.on('data', this.onError.bind(this));
        proc.on('close', this.onClose.bind(this))
        proc.on('drain', function(){
            proc.stdout.resume();
        });
        this.request.connection.on('close',function(){
            Debug.debug("close video play connection!");
            proc.kill("SIGINT");
        });
    }


    onData(data) {
        this.bufferedChuncks++;
        if(this.bufferedChuncks>20)
        {
            this.proc.stdout.pause();
        }

        this.response.write(data, function () {
            this.bufferedChuncks--;
            this.proc.stdout.resume();
        }.bind(this));
    }

    onError(data)
    {
        Debug.warning("ffmpeg error:"+`${data}`);
    }

    onClose(code)
    {
        Debug.debug("Close:"+code, this.tmpFile);
        fs.unlink(this.tmpFile);
    }
}

module.exports = Mpeg4PlayHandler;