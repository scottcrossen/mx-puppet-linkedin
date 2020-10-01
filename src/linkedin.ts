import {
  API,
  convertUrnToId,
  CookieJar,
  FileBackedCookiePersistence,
  Logger,
  MessageDetails,
  SeenDetails,
  TypingDetails,
  Urn,
  UrnId,
} from 'linkedin-voyager';
import {
  IMessageEvent,
  IRemoteRoom,
  IRemoteUser,
  IRetList,
  ISendingUser,
  Log,
  MessageDeduplicator,
  PuppetBridge,
} from 'mx-puppet-bridge';

interface ILinkedinPuppet {
  data: {
    username: string;
    password?: string;
  };
  client: API;
  stopClients: (() => Promise<void>)[];
}

const log = new Log('LinkedInPuppet:linkedin');
const sdkLog = new Log('LinkedInPuppet:sdk');
const sdkLogConfig: Logger = {
  debug: (data) => sdkLog.info(data),
  info: (data) => sdkLog.info(data),
  warn: (data) => sdkLog.warn(data),
  error: (data) => sdkLog.error(data),
};

export class App {
  private puppets: { [puppetId: number]: ILinkedinPuppet } = {};
  private cookieJar: CookieJar;
  private messageDeduplicator: MessageDeduplicator = new MessageDeduplicator();

  constructor(private readonly puppet: PuppetBridge, cookieDirectory: string) {
    this.cookieJar = new CookieJar(
      new FileBackedCookiePersistence(cookieDirectory, sdkLogConfig),
    );
  }

  private async handleError(puppetId: number, details: unknown): Promise<void> {
    const puppet = this.puppets[puppetId];
    const usernameString = puppet ? ` (${puppet.data.username})` : '';
    try {
      log.error(
        `Error received from from remote for puppet ${puppetId}${usernameString}.`,
      );
      await this.puppet.sendStatusMessage(
        puppetId,
        `An async error occured for puppet ${puppetId} bridge${usernameString}. Dumping error into bridge logs and control room (alpha only).`,
      );
      await this.puppet.sendStatusMessage(puppetId, JSON.stringify(details));
    } catch (err) {
      log.error(
        `Error handling remote error event for puppet ${puppetId}.`,
        err,
      );
    } finally {
      log.error(JSON.stringify(details));
    }
  }

  private getRoomParams(puppetId: number, conversationId: UrnId): IRemoteRoom {
    return {
      puppetId,
      roomId: conversationId,
    };
  }

  private getUserParams(puppetId: number, profileUrn: Urn): IRemoteUser {
    return {
      puppetId,
      userId: convertUrnToId(profileUrn),
    };
  }

  public async handleLinkedInMessage(
    puppetId: number,
    messageDetails: MessageDetails,
  ): Promise<void> {
    log.info(`Handling message from LinkedIn for puppet ${puppetId}`);
    const puppet = this.puppets[puppetId];
    if (!puppet) {
      return;
    }
    const params = {
      room: this.getRoomParams(puppetId, messageDetails.conversationId),
      user: this.getUserParams(puppetId, messageDetails.from.profileUrn),
    };
    const dedupeKey = `${puppetId};${params.room.roomId}`;
    if (
      await this.messageDeduplicator.dedupe(
        dedupeKey,
        params.user.userId,
        undefined,
        messageDetails.message.body || '',
      )
    ) {
      return;
    }
    const opts = {
      body: messageDetails.message.body,
    };
    await this.puppet.sendMessage(params, opts);
  }

  public async handleLinkedInSeen(
    puppetId: number,
    seenDetails: SeenDetails,
  ): Promise<void> {
    log.info(`Handling seen receipt from LinkedIn for puppet ${puppetId}`);
    const params = {
      room: this.getRoomParams(puppetId, seenDetails.conversationId),
      user: this.getUserParams(puppetId, seenDetails.from.profileUrn),
    };
    await this.puppet.sendReadReceipt(params);
  }

  public async handleLinkedInTyping(
    puppetId: number,
    typingDetails: TypingDetails,
  ): Promise<void> {
    log.info(`Handling typing from LinkedIn for puppet ${puppetId}`);
    const puppet = this.puppets[puppetId];
    if (!puppet) {
      return;
    }
    const params = {
      room: this.getRoomParams(puppetId, typingDetails.conversationId),
      user: this.getUserParams(puppetId, typingDetails.from.profileUrn),
    };
    await this.puppet.setUserTyping(params, true);
  }

  public async handleMatrixMessage(
    room: IRemoteRoom,
    data: IMessageEvent,
    asUser: ISendingUser | null,
  ): Promise<void> {
    log.info(`Got new message event from matrix for puppet ${room.puppetId}`);
    const puppet = this.puppets[room.puppetId];
    if (!puppet) {
      return;
    }
    let message = data.body;
    if (asUser) {
      message = `${asUser.displayname}: ${message}`;
    }
    const dedupeKey = `${room.puppetId};${room.roomId}`;
    const puppetUrnId = convertUrnToId(
      (await puppet.client.profile.me()).profileUrn,
    );
    this.messageDeduplicator.lock(dedupeKey, puppetUrnId, message);
    await puppet.client.messaging.sendToConversation(room.roomId, message);
    this.messageDeduplicator.unlock(dedupeKey, puppetUrnId);
  }

  // TODO: Handle matrix seen

  // TODO: Handle matrix typing

  public async deletePuppet(puppetId: number): Promise<void> {
    log.info(`Got signal to quit puppet ${puppetId}`);
    if (!this.puppets[puppetId]) {
      return;
    }
    await this.stopPuppetClient(puppetId);
    delete this.puppets[puppetId];
  }

  public async newPuppet(
    puppetId: number,
    data: {
      username: string;
      password?: string;
    },
  ): Promise<void> {
    log.info(`Adding new puppet ${puppetId} (${data.username})`);
    if (this.puppets[puppetId]) {
      await this.deletePuppet(puppetId);
    }
    const api = new API(data.username, {
      cookieJar: this.cookieJar,
      log: sdkLogConfig,
    });
    if (data.password) {
      api.setPassword(data.password);
    }
    this.puppets[puppetId] = {
      data,
      client: api,
      stopClients: [],
    };
    await this.startPuppetClient(puppetId);
  }

  public async stopPuppetClient(puppetId: number): Promise<void> {
    log.info(`Stopping puppet client for puppet ${puppetId}.`);
    if (!this.puppets[puppetId]) {
      return;
    }
    const puppet = this.puppets[puppetId];
    await Promise.all(puppet.stopClients.map((callable) => callable()));
  }

  public async startPuppetClient(puppetId: number): Promise<void> {
    const puppet = this.puppets[puppetId];
    if (!puppet) {
      return;
    }
    log.info(`Starting puppet client for puppet ${puppetId}.`);
    try {
      log.info(`Gathering details about puppet ${puppetId}`);
      log.info(await puppet.client.profile.me());
    } catch (err) {
      await this.handleError(puppetId, err);
      // TODO: fix mx-puppet-bridge so that the rejected promises are actually handled correctly.
      return Promise.resolve();
    }
    log.info(`Attaching message listener for puppet ${puppetId}.`);
    puppet.stopClients.push(
      await puppet.client.messaging.messages(
        async (message: MessageDetails) => {
          try {
            log.info(
              `Got new message event from remote for puppet ${puppetId}.`,
            );
            await this.handleLinkedInMessage(puppetId, message);
          } catch (err) {
            log.error(`Error handling remote message event`, err);
          }
        },
      ),
    );
    log.info(`Attaching seen listener for puppet ${puppetId}.`);
    puppet.stopClients.push(
      await puppet.client.messaging.seen(async (details: SeenDetails) => {
        try {
          log.info(`Got new seen event from remote for puppet ${puppetId}.`);
          await this.handleLinkedInSeen(puppetId, details);
        } catch (err) {
          log.error(
            `Error handling remote seen event for puppet ${puppetId}.`,
            err,
          );
        }
      }),
    );
    log.info(`Attaching typing listener for puppet ${puppetId}.`);
    puppet.stopClients.push(
      await puppet.client.messaging.typing(async (details: TypingDetails) => {
        try {
          log.info(`Got new typing event from remote for puppet ${puppetId}.`);
          await this.handleLinkedInTyping(puppetId, details);
        } catch (err) {
          log.error(
            `Error handling remote typing event for puppet ${puppetId}.`,
            err,
          );
        }
      }),
    );
    log.info(`Attaching ping listener for puppet ${puppetId}.`);
    puppet.stopClients.push(
      await puppet.client.misc.ping(() => {
        log.info(`Recieved ping from remote for puppet ${puppetId}.`);
      }),
    );
    log.info(`Attaching error listener for puppet ${puppetId}.`);
    puppet.stopClients.push(
      await puppet.client.misc.errors(async (details: unknown) => {
        await this.handleError(puppetId, details);
      }),
    );
  }

  public async listRooms(puppetId: number): Promise<IRetList[]> {
    log.info(`Listing rooms for puppet ${puppetId}.`);
    const puppet = this.puppets[puppetId];
    if (!puppet) {
      return;
    }
    const conversations = await puppet.client.messaging.conversations();
    return conversations
      .filter((conversation) => conversation.participants.length !== 1)
      .map((conversation) => {
        return {
          name: conversation.participants
            .map((user) => user.firstName)
            .join(', '),
          id: conversation.conversationId,
        };
      });
  }

  public async listUsers(puppetId: number): Promise<IRetList[]> {
    log.info(`Listing rooms for puppet ${puppetId}.`);
    const puppet = this.puppets[puppetId];
    if (!puppet) {
      return;
    }
    const conversations = await puppet.client.messaging.conversations();
    return conversations
      .filter((conversation) => conversation.participants.length === 1)
      .map((conversation) => {
        const dmUser = conversation.participants[0];
        return {
          name: `${dmUser.firstName} ${dmUser.lastName}`,
          id: conversation.conversationId,
        };
      });
  }
}
