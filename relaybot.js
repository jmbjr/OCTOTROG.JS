"use strict";
var fs = require('fs');
var irc = require('irc');
var extend = require('extend');
var vsprintf = require('sprintf').vsprintf;

var defaults = {
  max_line_length: 300,
  irc_options: {
    stripColors: true,
    floodProtection: true
  }
};

var relaybot = {
  create: function(opt) {
    var bot = Object.create(relaybot);
    extend(true, bot, defaults, opt);
    bot.irc_options.channels = [opt.main_channel];
    bot.main_client = new irc.Client(bot.main_server, bot.main_nick, bot.irc_options);
    bot.irc_options.channels = [opt.relay_channel];
    bot.relay_client = new irc.Client(bot.relay_server, bot.relay_nick, bot.irc_options);
    ['join', 'message', 'kick'].forEach(function(l) {
      bot.main_client.addListener(l, bot.main_listeners[l].bind(bot));
    });
    bot.relay_client.addListener('message', bot.relay_message.bind(bot));
    bot.load_data();
    // TODO: detect nick change?
    return bot;
  },

  add_sources: function(sources) {
    this.sources = this.sources || {};
    extend(true, this.sources, sources);
    this.command_map = {};
    this.relays = {};
    Object.keys(this.sources).forEach(function(s) {
      var source = this.sources[s];
      source.name = (source.type === 'self') ? this.main_nick : s;
      if (source.type === 'relay') this.relays[s] = [];
      if (Array.isArray(source.commands)) {
        source.commands.forEach(function(c) {
          if (typeof c.command !== 'string') return;
          c.command = c.command.toLowerCase();
          if (this.command_map[c.command]) {
            console.log("Warning: Duplicate command \"" + c.command + "\" for source " + s + "; was already assigned to " + this.command_map[c.command]);
            return;
          }
          this.command_map[c.command] = s;
        }, this);
      }
    }, this);
  },

  get_source: function(command) {
    if (typeof command !== 'string') return;
    command = command.toLowerCase();
    var source_name = this.command_map[command];
    if (typeof source_name !== 'string') return;
    if (typeof this.sources[source_name] !== 'object') return;
    return this.sources[source_name];
  },

  main_listeners: {
    'message': function(nick, to, text, message) {
      var params = text.split(/ +/);
      var action = params.shift().toLowerCase();
      var source = this.get_source(action);
      if (!source) return;
      if (typeof source.type !== 'string') return;
      if (typeof this.command_handlers[source.type] !== 'function') return;
      this.command_handlers[source.type].call(this, {
        source: source,
        fulltext: text,
        action: action,
        reply: (to === this.main_nick ? nick : to),
        params: params
      });
    },
    'join': function(channel, nick, message) {
      if (nick !== this.main_nick) return;
      if (channel !== this.main_channel) return;
      if (this.kicked_flag) {
        this.say_phrase(channel, 'kicked');
        this.kicked_flag = false;
      } else {
        this.say_phrase(channel, 'greeting');
      }
    },
    'kick': function(channel, nick, by, reason, message) {
      // set flag so bot will complain on rejoin
      if (nick === this.main_nick) this.kicked_flag = true;
    }
  },

  relay_message: function(nick, to, text, message) {
    var target;
    // was message sender a watched relay bot?
    if (typeof this.relays[nick] === 'undefined') return;
    target = this.relays[nick][0];
    if (typeof target !== 'string') {
      // default to main channel if there's no relay target
      target = this.main_channel;
    } else {
      // todo: properly check length of relay message
      // currently assumed to be 1 line, so any extra lines will mess it up
      this.relays[nick].pop();
    }
    if (to === this.relay_nick || this.check_watchlist(text)) {
      this.main_client.say(target, text);
    }
  },

  command_handlers: {
    'self': function(opt) {
      // bot's own actions
      if (typeof this.self_actions[opt.action] === 'function') {
        this.self_actions[opt.action].call(this, opt);
      }
    },
    'relay': function(opt) {
      this.relays[opt.source.name].push(opt.reply);
      this.relay_client.say(opt.source.name, opt.fulltext);
    }
  },

  self_actions: {
    '!watch': function(opt) {
      var nick = opt.params.shift();
      if (this.check_watched_nick(nick)) {
        this.say_phrase(opt.reply, 'watched_already', nick);
      } else if (this.modify_watchlist(nick, true)) {
        this.say_phrase(opt.reply, 'watch_added', nick);
      } else {
        // TODO: error
      }
    },
    '!unwatch': function(opt) {
      var nick = opt.params.shift();
      if (!this.check_watched_nick(nick)) {
        this.say_phrase(opt.reply, 'unwatched_already', nick);
      } else if (this.modify_watchlist(nick, false)) {
        this.say_phrase(opt.reply, 'watch_removed', nick);
      } else {
        // TODO: error
      }

    },
    '!watched': function(opt) {
      var watchtext = 'nobody';
      var watchlist = this.get_watchlist();
      if (watchlist) watchtext = watchlist.join(' ');
      this.say_phrase(opt.reply, 'watched', watchtext);
    },
    '!help': function(opt) {
      var source, cmd;
      var cmdlist = [];
      if (opt.params.length === 0) {
        Object.keys(this.command_map).forEach(function(c) {
          cmdlist.push(c);
        });
        this.say_phrase(opt.reply, 'help', cmdlist.join(' '));
        return;
      }
      cmd = opt.params[0].toLowerCase();
      source = this.get_source(opt.params[0]);
      if (!source) {
        this.say_phrase(opt.reply, 'help_notfound', opt.params[0]);
        return;
      }
      this.say_text(opt.reply, 'Provided by: ' + source.name);
      if (source.description) {
        this.say_text(opt.reply, source.description);
      } else {
        this.say_phrase(opt.reply, 'help_not_available', opt.params[0]);
      }
    }
  },

  check_watched_nick: function(key) {
    var list = this.get_watchlist();
    return (list && list.indexOf(key.toLowerCase()) !== -1);
  },

  check_watchlist: function(text) {
    var watchlist;
    if (typeof text !== 'string') return;
    watchlist = this.get_watchlist();
    if (!watchlist) return;
    text = text.toLowerCase();
    return watchlist.some(function(nick) {
      if (text.indexOf(nick) > -1) return true;
    });
  },

  get_watchlist: function() {
    if (typeof this.saved.watchlist !== 'object') return;
    return Object.keys(this.saved.watchlist).sort();
  },

  modify_watchlist: function(nick, add) {
    if (typeof nick !== 'string') return;
    if (typeof this.saved.watchlist !== 'object') this.saved.watchlist = {};
    nick = nick.toLowerCase();
    if (add) {
      this.saved.watchlist[nick] = null;
    } else if (typeof this.saved.watchlist[nick] !== 'undefined') {
      delete(this.saved.watchlist[nick]);
    }
    return this.save_data();
  },

  save_data: function() {
    try {
      fs.writeFile(this.savefile, JSON.stringify(this.saved, null, 1));
      return true;
    } catch (e) {
      console.log("Could not save file! " + this.savefile);
      console.log(e);
      return false;
    }
  },

  load_data: function() {
    if (!fs.existsSync(this.savefile)) {
      this.saved = {};
      return;
    }
    this.saved = JSON.parse(fs.readFileSync(this.savefile));
  },

  say_phrase: function(target, string_key) {
    if (typeof string_key !== 'string' || !this.sayings[string_key]) {
      console.log("GRR INVALID STRING KEY! " + string_key.toString());
      return;
    }
    arguments[1] = this.sayings[string_key];
    return this.say_text.apply(this, arguments);
  },

  say_text: function(target, text) {
    var args = Array.prototype.slice.call(arguments, 2);
    var linepos = 0;
    if (args.length > 0) text = vsprintf(text, args);
    if (typeof this.say_transform === 'function') {
      text = this.say_transform(text);
    }
    if (this.max_line_length) {
      text = this.split_line(text, this.max_line_length);
    } else {
      text = [text];
    }
    text.forEach(function(e) {
      this.main_client.say(target, e);
    }, this);
  },

  split_line: function(text, length) {
    var out = [], pos;
    if (!length || typeof text !== 'string') return;
    while (text.length > length) {
      pos = length;
      while (pos > 0 && text.charAt(pos) !== ' ') pos--;
      if (pos === 0) pos = length;
      out.push(text.substr(0, pos));
      text = text.substr(pos + 1);
    }
    out.push(text);
    return out;
  }

};

module.exports = relaybot;
