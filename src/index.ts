import * as commandLineArgs from 'command-line-args';
import * as commandLineUsage from 'command-line-usage';
import {
  IProtocolInformation,
  IPuppetData,
  IRetData,
  Log,
  PuppetBridge,
} from 'mx-puppet-bridge';
import { LinkedInConfigWrap } from './config';
import { App } from './linkedin';

const log = new Log('LinkedInPuppet:index');

const commandOptions = [
  { name: 'register', alias: 'r', type: Boolean },
  { name: 'registration-file', alias: 'f', type: String },
  { name: 'config', alias: 'c', type: String },
  { name: 'help', alias: 'h', type: Boolean },
];

const options = Object.assign(
  {
    register: false,
    'registration-file': 'linkedin-registration.yaml',
    config: 'config.yaml',
    help: false,
  },
  commandLineArgs(commandOptions),
);

if (options.help) {
  // tslint:disable-next-line:no-console
  console.log(
    commandLineUsage([
      {
        header: 'Matrix LinkedIn Puppet Bridge',
        content: 'A matrix puppet bridge for linkedin',
      },
      {
        header: 'Options',
        optionList: commandOptions,
      },
    ]),
  );
  process.exit(0);
}

const protocol = {
  features: {
    typingTimeout: 5500,
  },
  id: 'linkedin',
  displayname: 'LinkedIn',
  externalUrl: 'https://linkedin.com',
  namePatterns: {
    user: ':name (LinkedIn)',
    room: ':name (LinkedIn)',
    group: ':name (LinkedIn)',
  },
} as IProtocolInformation;

const puppet = new PuppetBridge(
  options['registration-file'],
  options.config,
  protocol,
);

if (options.register) {
  puppet.readConfig(false);
  try {
    puppet.generateRegistration({
      prefix: '_linkedinpuppet_',
      id: 'linkedin-puppet',
      url: `http://${puppet.Config.bridge.bindAddress}:${puppet.Config.bridge.port}`,
    });
  } catch (err) {
    console.log("Couldn't generate registration file:", err);
  }
  process.exit(0);
}

enum PuppetAction {
  NEW_PUPPET = 'puppetNew',
  DELETE_PUPPET = ' puppetDelete',
  MESSAGE = 'message',
}

async function run() {
  log.info('Initializing LinkedIn Bridge');
  await puppet.init();
  const config = await LinkedInConfigWrap.fromConfig(options.config);
  const linkedin = new App(puppet, config.cookies.directory);
  puppet.on(PuppetAction.NEW_PUPPET, linkedin.newPuppet.bind(linkedin));
  puppet.on(PuppetAction.DELETE_PUPPET, linkedin.deletePuppet.bind(linkedin));
  puppet.on(PuppetAction.MESSAGE, linkedin.handleMatrixMessage.bind(linkedin));
  puppet.setGetDescHook(
    async (_: number, data: IPuppetData): Promise<string> => {
      return `LinkedIn puppet ${data.username}`;
    },
  );
  puppet.setGetDataFromStrHook(
    async (str: string): Promise<IRetData> => {
      const extractParts = /^\s*(?<username>[^@]+@[^\s]+)\s*(?<password>[^\s]+)\s*$/;
      const data = str.match(extractParts)?.groups;
      if (!data) {
        return {
          success: false,
          error: 'Must provide "<username> <password>"',
        };
      }
      return {
        success: true,
        data: { ...data },
      };
    },
  );
  puppet.setBotHeaderMsgHook((): string => {
    return 'LinkedIn Puppet Bridge';
  });
  log.info('Starting LinkedIn Bridge');
  await puppet.start();
  log.info('Finished LinkedIn Bridge');
}

run();
