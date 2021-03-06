const TheMovieDBExtendedInfo = require('./extendedInfo/TheMovieDBExtendedInfo');
const FFProbeExtendedInfo = require('./extendedInfo/FFProbeExtendedInfo');
const ParseFileNameExtendedInfo = require('./extendedInfo/ParseFileNameExtendedInfo');
const TheMovieDBSeriesAndSeasons = require('./extendedInfo/TheMovieDBSeriesAndSeasons');
const ExtrasExtendedInfo = require('./extendedInfo/ExtrasExtendedInfo');
const Database = require('../Database');
const Log = require('../helpers/Log');
const Settings = require('../Settings');
const DebugApiHandler = require('../requestHandlers/api/DebugApiHandler');

const extendedInfoItems = [
  FFProbeExtendedInfo,
  ParseFileNameExtendedInfo,
  TheMovieDBSeriesAndSeasons,
  TheMovieDBExtendedInfo,
  ExtrasExtendedInfo,
];

class ExtendedInfoQueue {
  static getInstance() {
    if (!ExtendedInfoQueue.instance) {
      ExtendedInfoQueue.instance = new ExtendedInfoQueue();
      DebugApiHandler.registerDebugInfoProvider(
        'scanner',
        ExtendedInfoQueue.instance.debugInfo.bind(ExtendedInfoQueue.instance),
      );
    }
    return ExtendedInfoQueue.instance;
  }

  constructor() {
    this.onDrainCallbacks = [];
    this.queue = [];
    this.running = false;
  }

  push(item) {
    // extras should be processed last
    if (item.attributes.extra) {
      this.queue.unshift(item);
    } else {
      this.queue.push(item);
    }

    clearTimeout(this.timeout);
    if (!this.running) {
      this.timeout = setTimeout(this.start.bind(this), 5000);
    }
  }

  concat(items) {
    items.forEach(item => this.push(item));
  }

  async start() {
    const libs = {};
    Settings.getValue('libraries').forEach((library) => {
      libs[library.uuid] = library;
    });

    this.running = true;
    Log.debug('processing', this.queue.length);

    while (this.queue.length) {
      const item = this.queue.pop();
      for (let c = 0; c < extendedInfoItems.length; c += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await extendedInfoItems[c].extendInfo(item, libs[item.attributes.libraryId]);
        } catch (e) {
          Log.exception(e);
        }
      }
      Database.update('media-item', item);
    }
    this.onDrainCallbacks.forEach(cb => cb());
    Log.info('done checking extended info');

    this.running = false;
  }

  setOnDrain(cb) {
    this.onDrainCallbacks.push(cb);
  }

  debugInfo() {
    return { extendedInfoQuelength: this.queue.length };
  }
}

module.exports = ExtendedInfoQueue;
