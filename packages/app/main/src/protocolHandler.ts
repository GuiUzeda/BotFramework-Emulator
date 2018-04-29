import * as QueryString from 'querystring';
import * as got from 'got';
import * as Electron from 'electron';

import { IFrameworkSettings, newBot, newEndpoint } from '@bfemulator/app-shared';
import { IBotConfig, IEndpointService } from '@bfemulator/sdk-shared';
import { Protocol } from './constants';
import { mainWindow } from './main';
import * as BotActions from './data-v2/action/bot';
import { ngrokEmitter } from './ngrok';
import { getSettings } from './settings';
import { decodeBase64 } from './utils';

enum ProtocolDomains {
  livechat,
  transcript,
  bot
}

enum ProtocolLiveChatActions {
  open
}

enum ProtocolTranscriptActions {
  open
}

enum ProtocolBotActions {
  open
}

interface IProtocol {
  // the 'controller'
  domain?: string;
  // the 'action' or 'route' within the controller
  action?: string;
  // any extra info passed in
  args?: string;
  // object reprsentation of args
  parsedArgs?: { [key: string]: string } | any;
}

interface IProtocolHandler {
  parseProtocolUrl: (url: string) => IProtocol;
  dispatchProtocolAction: (protocol: IProtocol) => void;
  performLiveChatAction: (protocol: IProtocol) => void;
  performTranscriptAction: (protocol: IProtocol) => void;
  performBotAction: (protocol: IProtocol) => void;
}

export const ProtocolHandler = new class ProtocolHandler implements IProtocolHandler {
  constructor() {}

  /** Extracts useful information out of a protocol URL */
  parseProtocolUrl(url: string): IProtocol {
    const validProtocol = /^bfemulator:\/\//;
    if (!validProtocol.test(url)) {
      throw new Error(`Invalid protocol url. Must start with '${Protocol}'`);
    }

    // grab what's left after the protocol prefix (protocol automatically places '/' before query string params)
    const restOfUrl = url.substring(Protocol.length).replace(/\//g, '');

    // split into two parts: domain.action?args -> ['domain.action', 'args']
    const chunks = restOfUrl.split('?');
    const domainAndAction = chunks[0].split('.');

    const domain = (domainAndAction[0] || '').toLowerCase();
    const action = (domainAndAction[1] || '').toLowerCase();
    const args = (chunks[1] || '');
    const parsedArgs = QueryString.parse(args);

    const info: IProtocol = {
      domain,
      action,
      args,
      parsedArgs
    };

    return info;
  }

  /** Uses information from a protocol URL and carries out the corresponding action */
  dispatchProtocolAction(protocol: IProtocol): void {
    switch (ProtocolDomains[protocol.domain]) {
      case ProtocolDomains.bot:
        this.performBotAction(protocol);
        break;

      case ProtocolDomains.livechat:
        this.performLiveChatAction(protocol);
        break;

      case ProtocolDomains.transcript:
        this.performTranscriptAction(protocol);
        break;

      default:
        break;
    }
  }

  /** Reads in a protocol URL and then performs the corresponding action if valid */
  parseProtocolUrlAndDispatch(url: string): void {
    this.dispatchProtocolAction(this.parseProtocolUrl(url));
  }

  performLiveChatAction(protocol: IProtocol): void {
    switch (ProtocolLiveChatActions[protocol.action]) {
      case ProtocolLiveChatActions.open:
        this.openLiveChat(protocol);
        break;

      default:
        break;
    }
  }

  performTranscriptAction(protocol: IProtocol): void {
    switch(ProtocolTranscriptActions[protocol.action]) {
      case ProtocolTranscriptActions.open:
        this.openTranscript(protocol);
        break;

      default:
        break;
    }
  }

  performBotAction(protocol: IProtocol): void {
    switch(ProtocolBotActions[protocol.action]) {
      case ProtocolBotActions.open:
        this.openBot(protocol);
        break;

      default:
        break;
    }
  }

  /** Mocks a bot object with any configuration parsed from the
   *  protocol string and starts a live chat session with that bot
  */
  private openLiveChat(protocol: IProtocol): void {
    // mock up a bot object
    const { botUrl, msaAppId, msaPassword } = protocol.parsedArgs;
    const bot: IBotConfig = newBot();
    const endpoint: IEndpointService = newEndpoint();

    endpoint.endpoint = decodeBase64(botUrl);
    endpoint.appId = decodeBase64(msaAppId);
    endpoint.appPassword = decodeBase64(msaPassword);
    bot.services.push(endpoint);
    mainWindow.store.dispatch(BotActions.mockAndSetActive(bot));

    const appSettings: IFrameworkSettings = getSettings().framework;

    if (appSettings.ngrokPath) {
      // if ngrok is configured, wait for it to connect and start the livechat
      ngrokEmitter.once('connect', (...args: any[]): void => {
        mainWindow.commandService.remoteCall('livechat:new', endpoint);
      });
    } else {
      // try to connect and let the chat log show the user the error
      // TODO: We shouldn't have to wait for welcome to render
      // (we are still within the client:loaded command logic, which will show the welcome page afterwards;
      //  we need to wait for welcome page and then show the emulator tab so it's not unfocused)
      setTimeout(() => mainWindow.commandService.remoteCall('livechat:new', endpoint), 1000);
    }
  }

  /** Downloads a transcript from a URL provided in the protocol string,
   *  parses out the list of activities, and has the client side open it
   */
  private openTranscript(protocol: IProtocol): void {
    let { url } = protocol.parsedArgs;
    url = decodeBase64(url);
    const options = { url };

    got(options)
      .then(res => {
        if (/^2\d\d$/.test(res.statusCode)) {
          if (res.body) {
            try {
              // parse the activities from the downloaded transcript
              const transcriptString = res.body;
              const conversationActivities = JSON.parse(transcriptString);
              if (!Array.isArray(conversationActivities))
                throw new Error('Invalid transcript file contents; should be an array of conversation activities.');

              // open a transcript on the client side and pass in some extra info to differentiate it from a transcript on disk
              mainWindow.commandService.remoteCall('transcript:open', 'deepLinkedTranscript', { activities: conversationActivities, deepLink: true });
            } catch (e) {
              throw new Error(`Error occured while reading downloaded transcript: ${e}`);
            }
          }
        } else {
          if (res.statusCode === 401) {
            // auth failed
            throw new Error(`Authorization error while trying to download transcript: ${res.body || res.statusText || ''}`);
          }
          if (res.statusCode === 404) {
            // transcript link is broken / doesn't exist anymore
            throw new Error(`Transcript file not found at: ${url}`);
          }
        }
      })
      .catch(err => {
        // TODO: surface this error somewhere; native error box?
        console.error('Error downloading and parsing transcript file: ', err)
      });
  }

  /** Opens the bot project associated with the .bot file at the specified path */
  private openBot(protocol: IProtocol): void {
    let { path, secret }: { path: string, secret: string } = protocol.parsedArgs;
    path = decodeBase64(path);
    secret = secret ? decodeBase64(secret) : null;

    const appSettings: IFrameworkSettings = getSettings().framework;
    if (appSettings.ngrokPath) {
      // if ngrok is configured, wait for it to connect and load the bot
      ngrokEmitter.once('connect', (...args: any[]): void => {
        mainWindow.commandService.call('bot:load', path, secret)
          .then(() => console.log('opened bot successfully'))
          // TODO: surface this error somewhere; native error box?
          .catch(err => { throw new Error(`Error occurred while trying to deep link to bot project at: ${path}`) });
      });
    } else {
      // load the bot and let the chat log show the user the error
      // TODO: We shouldn't have to wait for welcome to render
      // (we are still within the client:loaded command logic, which will show the welcome page afterwards;
      //  we need to wait for welcome page and then show the emulator tab so it's not unfocused)
      setTimeout(() =>
        mainWindow.commandService.call('bot:load', path, secret)
          .then(() => console.log('opened bot successfully'))
          // TODO: surface this error somewhere; native error box?
          .catch(err => { throw new Error(`Error occurred while trying to deep link to bot project at: ${path}`) })
      , 1000);
    }
  }
}
