import EventEmitter from 'events'
import { IPCTransport } from './ipc'
import { RPCCommands, RPCEvents, RelationshipTypes } from './constants'
import { uuid } from './utils'


interface CertifiedDevice {
  type: 'AUDIO_INPUT' | `AUDIO_OUTPUT` | `VIDEO_INPUT`
  uuid: string
  vendor: {
    name: string
    url: string
  }
  model: {
    name: string
    url: string
  }
  related: string[]
  echoCancellation: boolean
  noiseSuppression: boolean
  automaticGainControl: boolean
  hardwareMute: boolean
}

interface UserVoiceSettings {
  id: string
  pan?: {
    left: number
    right: number
  }
  volume?: number
  mute?: boolean
}

interface RPCLoginOptions {
  clientId: string
  clientSecret?: string
  accessToken?: string
  rpcToken?: string
  tokenEndpoint?: string
  scopes?: string[]
}

const subKey = (event: string, args?: any) => {
  return `${event}${JSON.stringify(args)}`;
}

export class Client extends EventEmitter {
  options: any
  accessToken: string | null = null
  clientId: string | null = null
  application: any = null
  user: any | null = null
  transport: IPCTransport
  endpoint: string = 'https://discord.com/api'
  _expecting = new Map()
  _connectPromise: undefined | Promise<Client> = undefined
  _subscriptions = new Map()

  constructor(options = {}) {
    super()

    this.options = options
    this.transport = new IPCTransport(this)
    this.transport.on('message', this._onRpcMessage.bind(this));
  }

  async fetch(method: string, path: string, { data, query }: any = {}): Promise<any> {
    return fetch(`${this.endpoint}${path}${query ? new URLSearchParams(query) : ''}`, {
      method,
      body: data,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      }
    }).then(async (res) => {
      const body = await res.json();

      if (!res.ok) {
        const err: any = new Error(res.status.toString())
        err.body = body
        throw err
      }

      return body
    })
  }

  /**
   * Search and connect to Discord over IPC
   */
  connect(clientId: string): undefined | Promise<Client> {
    if (this._connectPromise) {
      return this._connectPromise;
    }

    this._connectPromise = new Promise((resolve, reject) => {
      this.clientId = clientId

      const timeout = setTimeout(() => reject(new Error('RPC_CONNECTION_TIMEOUT')), 10e3);
      timeout.unref()

      this.once('connected', () => {
        clearTimeout(timeout)
        resolve(this)
      })

      this.transport.once('close', () => {
        this._expecting.forEach((e) => {
          e.reject(new Error('connection closed'))
        })

        this.emit('disconnected')
        reject(new Error('connection closed'))
      })

      this.transport.connect().catch(reject)
    })

    return this._connectPromise
  }

  /**
   * Performs authentication flow. Automatically calls Client#connect if needed.
   * @param {RPCLoginOptions} options Options for authentication.
   * At least one property must be provided to perform login.
   * @example client.login({ clientId: '1234567', clientSecret: 'abcdef123' });
   * @returns {Promise<RPCClient>}
   */
  async login(options: RPCLoginOptions) {
    let { clientId, accessToken } = options
    await this.connect(clientId)

    if (!options.scopes) {
      this.emit('ready')
      return this
    }

    if (!accessToken) {
      accessToken = await this.authorize(options) as string
    }

    return this.authenticate(accessToken)
  }

  /**
   * Request
   * @param {string} cmd Command
   * @param {Object} [args={}] Arguments
   * @param {string} [evt] Event
   * @returns {Promise}
   */
  request(cmd: string, args?: any, evt?: string) {
    return new Promise((resolve, reject) => {
      const nonce = uuid()
      this.transport.send({ cmd, args, evt, nonce })
      this._expecting.set(nonce, { resolve, reject })
    })
  }

  /**
   * Message handler
   * @param {Object} message message
   * @private
   */
  _onRpcMessage(message: any) {
    if (message.cmd === RPCCommands.DISPATCH && message.evt === RPCEvents.READY) {
      if (message.data.user) {
        this.user = message.data.user
      }

      this.emit('connected')
    } else if (this._expecting.has(message.nonce)) {
      const { resolve, reject } = this._expecting.get(message.nonce)

      if (message.evt === 'ERROR') {
        const e: any = new Error(message.data.message)
        e.code = message.data.code
        e.data = message.data

        reject(e)
      } else {
        resolve(message.data)
      }

      this._expecting.delete(message.nonce)
    } else {
      this.emit(message.evt, message.data)
    }
  }

  /**
   * Authorize
   * @param {Object} options options
   * @returns {Promise}
   * @private
   */
  async authorize({ scopes, clientSecret, rpcToken, redirectUri, prompt }: any = {}) {
    if (clientSecret && rpcToken === true) {
      const body = await this.fetch('POST', '/oauth2/token/rpc', {
        data: new URLSearchParams({
          client_id: this.clientId || '',
          client_secret: clientSecret
        })
      })

      rpcToken = body.rpc_token
    }

    const { code }: any = await this.request('AUTHORIZE', {
      scopes,
      client_id: this.clientId,
      prompt,
      rpc_token: rpcToken,
    })

    const response = await this.fetch('POST', '/oauth2/token', {
      data: new URLSearchParams({
        client_id: this.clientId || '',
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      })
    })

    return response.access_token
  }

  /**
   * Authenticate
   * @param {string} accessToken access token
   * @returns {Promise}
   * @private
   */
  authenticate(accessToken: string) {
    return this.request('AUTHENTICATE', { access_token: accessToken })
      .then(({ application, user }: any) => {
        this.accessToken = accessToken
        this.application = application
        this.user = user
        this.emit('ready')
        return this
      })
  }

  /**
   * Fetch a guild
   * @param {Snowflake} id Guild ID
   * @param {number} [timeout] Timeout request
   * @returns {Promise<Guild>}
   */
  getGuild(id: string, timeout?: number) {
    return this.request(RPCCommands.GET_GUILD, { guild_id: id, timeout })
  }

  /**
   * Fetch all guilds
   * @param {number} [timeout] Timeout request
   * @returns {Promise<Collection<Snowflake, Guild>>}
   */
  getGuilds(timeout?: number) {
    return this.request(RPCCommands.GET_GUILDS, { timeout })
  }

  /**
   * Get a channel
   * @param {Snowflake} id Channel ID
   * @param {number} [timeout] Timeout request
   * @returns {Promise<Channel>}
   */
  getChannel(id: string, timeout?: number) {
    return this.request(RPCCommands.GET_CHANNEL, { channel_id: id, timeout })
  }

  /**
   * Get all channels
   * @param {Snowflake} [id] Guild ID
   * @param {number} [timeout] Timeout request
   * @returns {Promise<Collection<Snowflake, Channel>>}
   */
  async getChannels(id?: string, timeout?: number) {
    const { channels }: any = await this.request(RPCCommands.GET_CHANNELS, {
      timeout,
      guild_id: id,
    })

    return channels
  }


  /**
   * Tell discord which devices are certified
   * @param {CertifiedDevice[]} devices Certified devices to send to discord
   * @returns {Promise}
   */
  setCertifiedDevices(devices: CertifiedDevice[]) {
    return this.request(RPCCommands.SET_CERTIFIED_DEVICES, {
      devices: devices.map((device) => ({
        type: device.type,
        id: device.uuid,
        vendor: device.vendor,
        model: device.model,
        related: device.related,
        echo_cancellation: device.echoCancellation,
        noise_suppression: device.noiseSuppression,
        automatic_gain_control: device.automaticGainControl,
        hardware_mute: device.hardwareMute
      }))
    })
  }

  /**
   * Set the voice settings for a user, by id
   * @param {Snowflake} id ID of the user to set
   * @param {UserVoiceSettings} settings Settings
   * @returns {Promise}
   */
  setUserVoiceSettings(id: string, settings: UserVoiceSettings) {
    return this.request(RPCCommands.SET_USER_VOICE_SETTINGS, {
      user_id: id,
      pan: settings.pan,
      mute: settings.mute,
      volume: settings.volume
    })
  }

  /**
   * Move the user to a voice channel
   * @param {Snowflake} id ID of the voice channel
   * @param {Object} [options] Options
   * @param {number} [options.timeout] Timeout for the command
   * @param {boolean} [options.force] Force this move. This should only be done if you
   * have explicit permission from the user.
   * @returns {Promise}
   */
  selectVoiceChannel(id: string, { timeout, force = false }: any = {}) {
    return this.request(RPCCommands.SELECT_VOICE_CHANNEL, { channel_id: id, timeout, force });
  }

  /**
   * Move the user to a text channel
   * @param {Snowflake} id ID of the voice channel
   * @param {Object} [options] Options
   * @param {number} [options.timeout] Timeout for the command
   * have explicit permission from the user.
   * @returns {Promise}
   */
  selectTextChannel(id: string, { timeout }: any = {}) {
    return this.request(RPCCommands.SELECT_TEXT_CHANNEL, { channel_id: id, timeout });
  }

  /**
   * Get current voice settings
   * @returns {Promise}
   */
  getVoiceSettings() {
    return this.request(RPCCommands.GET_VOICE_SETTINGS)
      .then((settings: any) => ({
        automaticGainControl: settings.automatic_gain_control,
        echoCancellation: settings.echo_cancellation,
        noiseSuppression: settings.noise_suppression,
        qos: settings.qos,
        silenceWarning: settings.silence_warning,
        deaf: settings.deaf,
        mute: settings.mute,
        input: {
          availableDevices: settings.input.available_devices,
          device: settings.input.device_id,
          volume: settings.input.volume,
        },
        output: {
          availableDevices: settings.output.available_devices,
          device: settings.output.device_id,
          volume: settings.output.volume,
        },
        mode: {
          type: settings.mode.type,
          autoThreshold: settings.mode.auto_threshold,
          threshold: settings.mode.threshold,
          shortcut: settings.mode.shortcut,
          delay: settings.mode.delay,
        },
      }));
  }

  /**
   * Set current voice settings, overriding the current settings until this session disconnects.
   * This also locks the settings for any other rpc sessions which may be connected.
   * @param {Object} args Settings
   * @returns {Promise}
   */
  setVoiceSettings(args: any) {
    return this.request(RPCCommands.SET_VOICE_SETTINGS, {
      automatic_gain_control: args.automaticGainControl,
      echo_cancellation: args.echoCancellation,
      noise_suppression: args.noiseSuppression,
      qos: args.qos,
      silence_warning: args.silenceWarning,
      deaf: args.deaf,
      mute: args.mute,
      input: args.input ? {
        device_id: args.input.device,
        volume: args.input.volume,
      } : undefined,
      output: args.output ? {
        device_id: args.output.device,
        volume: args.output.volume,
      } : undefined,
      mode: args.mode ? {
        type: args.mode.type,
        auto_threshold: args.mode.autoThreshold,
        threshold: args.mode.threshold,
        shortcut: args.mode.shortcut,
        delay: args.mode.delay,
      } : undefined,
    });
  }

  /**
   * Capture a shortcut using the client
   * The callback takes (key, stop) where `stop` is a function that will stop capturing.
   * This `stop` function must be called before disconnecting or else the user will have
   * to restart their client.
   * @param {Function} callback Callback handling keys
   * @returns {Promise<Function>}
   */
  captureShortcut(callback: any) {
    const subid = subKey(RPCEvents.CAPTURE_SHORTCUT_CHANGE);

    const stop = () => {
      this._subscriptions.delete(subid);
      return this.request(RPCCommands.CAPTURE_SHORTCUT, { action: 'STOP' });
    }

    this._subscriptions.set(subid, ({ shortcut }: any) => {
      callback(shortcut, stop);
    })

    return this.request(RPCCommands.CAPTURE_SHORTCUT, { action: 'START' })
      .then(() => stop)
  }

  /**
   * Sets the presence for the logged in user.
   * @param {object} args The rich presence to pass.
   * @param {number} [pid] The application's process ID. Defaults to the executing process' PID.
   * @returns {Promise}
   */
  setActivity(args: any = {}) {
    let timestamps: any
    let assets: any
    let party: any
    let secrets: any

    if (args.startTimestamp || args.endTimestamp) {
      timestamps = {
        start: args.startTimestamp,
        end: args.endTimestamp
      }

      if (timestamps.start instanceof Date) {
        timestamps.start = Math.round(timestamps.start.getTime())
      }

      if (timestamps.end instanceof Date) {
        timestamps.end = Math.round(timestamps.end.getTime())
      }

      if (timestamps.start > 2147483647000) {
        throw new RangeError('timestamps.start must fit into a unix timestamp')
      }

      if (timestamps.end > 2147483647000) {
        throw new RangeError('timestamps.end must fit into a unix timestamp')
      }
    }

    if (args.largeImageKey || args.largeImageText || args.smallImageKey || args.smallImageText) {
      assets = {
        large_image: args.largeImageKey,
        large_text: args.largeImageText,
        small_image: args.smallImageKey,
        small_text: args.smallImageText
      }
    }
    if (args.partySize || args.partyId || args.partyMax) {
      party = { id: args.partyId }

      if (args.partySize || args.partyMax) {
        party.size = [args.partySize, args.partyMax]
      }
    }
    if (args.matchSecret || args.joinSecret || args.spectateSecret) {
      secrets = {
        match: args.matchSecret,
        join: args.joinSecret,
        spectate: args.spectateSecret
      };
    }

    return this.request(RPCCommands.SET_ACTIVITY, {
      pid: process.pid,
      activity: {
        state: args.state,
        details: args.details,
        timestamps,
        assets,
        party,
        secrets,
        buttons: args.buttons,
        instance: !!args.instance
      }
    })
  }

  /**
   * Clears the currently set presence, if any. This will hide the "Playing X" message
   * displayed below the user's name.
   * @param {number} [pid] The application's process ID. Defaults to the executing process' PID.
   * @returns {Promise}
   */
  clearActivity() {
    return this.request(RPCCommands.SET_ACTIVITY, { pid: process.pid })
  }

  /**
   * Invite a user to join the game the RPC user is currently playing
   * @param {User} user The user to invite
   * @returns {Promise}
   */
  sendJoinInvite(user: any) {
    return this.request(RPCCommands.SEND_ACTIVITY_JOIN_INVITE, {
      user_id: user.id || user
    })
  }

  /**
   * Request to join the game the user is playing
   * @param {User} user The user whose game you want to request to join
   * @returns {Promise}
   */
  sendJoinRequest(user: any) {
    return this.request(RPCCommands.SEND_ACTIVITY_JOIN_REQUEST, {
      user_id: user.id || user,
    });
  }

  /**
   * Reject a join request from a user
   * @param {User} user The user whose request you wish to reject
   * @returns {Promise}
   */
  closeJoinRequest(user: any) {
    return this.request(RPCCommands.CLOSE_ACTIVITY_JOIN_REQUEST, {
      user_id: user.id || user,
    });
  }

  createLobby(type: any, capacity: any, metadata: any) {
    return this.request(RPCCommands.CREATE_LOBBY, {
      type,
      capacity,
      metadata
    })
  }

  updateLobby(lobby: any, { type, owner, capacity, metadata }: any = {}) {
    return this.request(RPCCommands.UPDATE_LOBBY, {
      id: lobby.id || lobby,
      type,
      owner_id: (owner && owner.id) || owner,
      capacity,
      metadata
    })
  }

  deleteLobby(lobby: any) {
    return this.request(RPCCommands.DELETE_LOBBY, {
      id: lobby.id || lobby
    })
  }

  connectToLobby(id: any, secret: any) {
    return this.request(RPCCommands.CONNECT_TO_LOBBY, {
      id,
      secret
    })
  }

  sendToLobby(lobby: any, data: any) {
    return this.request(RPCCommands.SEND_TO_LOBBY, {
      id: lobby.id || lobby,
      data
    })
  }

  disconnectFromLobby(lobby: any) {
    return this.request(RPCCommands.DISCONNECT_FROM_LOBBY, {
      id: lobby.id || lobby
    })
  }

  updateLobbyMember(lobby: any, user: any, metadata: any) {
    return this.request(RPCCommands.UPDATE_LOBBY_MEMBER, {
      lobby_id: lobby.id || lobby,
      user_id: user.id || user,
      metadata
    })
  }

  getRelationships() {
    const types = Object.keys(RelationshipTypes)

    return this.request(RPCCommands.GET_RELATIONSHIPS)
      .then((res: any) => {
        return res.relationships.map((relationship: any) => ({
          ...relationship,
          type: types[relationship.type],
        }))
      })
  }

  /**
   * Subscribe to an event
   * @param {string} event Name of event e.g. `MESSAGE_CREATE`
   * @param {Object} [args] Args for event e.g. `{ channel_id: '1234' }`
   * @returns {Promise<Object>}
   */
  async subscribe(event: string, args?: any) {
    await this.request(RPCCommands.SUBSCRIBE, args, event)

    return {
      unsubscribe: () => this.request(RPCCommands.UNSUBSCRIBE, args, event)
    }
  }

  /**
   * Destroy the client
   */
  async destroy() {
    await this.transport.close()
  }
}
