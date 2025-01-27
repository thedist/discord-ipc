import EventEmitter from 'events'
import { IPCTransport } from './ipc'
import { RPCCommands, RPCEvents, RelationshipTypes } from './constants'
import { uuid } from './utils'

export interface Activity {
  state: string
  details: string
  assets?: {
    large_image?: string
    large_text?: string
    small_image?: string
    small_text?: string
  }
  buttons?: string[]
  name: string
  application_id: string
  type: number
  metadata?: {
    button_urls?: string[]
  }
}

export interface Application {
  id: string
  name: string
  icon: string
  description: string
  summary?: string
  type?: any
  hook?: boolean
  terms_of_service_url?: string
  privacy_policy_url?: string
  verify_key?: string
  tags?: string[]
}

export interface CertifiedDevice {
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

export interface Channel {
  id: string
  guild_id: string
  name: string
  type: number
  topic?: string
  bitrate?: number
  user_limit?: number
  position: number
  voice_states?: any[]
  messages?: any[]
}

export interface ChannelsResponse {
  id: string
  name: string
  type: number
}

export interface Channels {
  channels: ChannelsResponse[]
}

export interface Guild {
  id: string
  name: string
  icon_url: string
  members: []
  vanity_url_code?: any
}

export interface Guilds {
  guilds: Partial<Guild>[]
}

export interface UserVoiceSettings {
  id: string
  pan?: {
    left: number
    right: number
  }
  volume?: number
  mute?: boolean
}

export interface RefreshTokenResponse {
  token_type: string
  access_token: string
  expires_in: number
  refresh_token: string
  scope: string
}

export interface RPCLoginOptions {
  clientId: string
  clientSecret?: string
  redirectUri?: string
  accessToken?: string
  refreshToken?: string
  rpcToken?: string
  tokenEndpoint?: string
  scopes?: string[]
}

export interface Subscription {
  unsubscribe: () => Promise<unknown>
}

export interface VoiceSettings {
  input: {
    available_devices: CertifiedDevice[]
    device_id: string
    volume: number
  }
  output: {
    available_devices: CertifiedDevice[]
    device_id: string
    volume: number
  }
  mode: {
    type: string
    auto_threshold: boolean
    threshold: number
    shortcut: any
    delay: number
  }
  automatic_gain_control: boolean
  echo_cancellation: boolean
  noise_suppression: boolean
  qos: boolean
  silence_warning: boolean
  deaf: boolean
  mute: boolean
}

export interface VoiceState {
  nick: string
  mute: boolean
  volume: number
  pan: {
    left: number
    right: number
  }
  voice_state: {
    mute: boolean
    deaf: boolean
    self_mute: boolean
    self_deaf: boolean
    suppress: boolean
  }
  user: {
    id: string
    username: string
    discriminator: string
    global_name: string
    avatar: string
    avatar_decoration_data?: any
    bot: boolean
    flags: number
    premium_type: number
  }
}

const subKey = (event: string, args?: any) => {
  return `${event}${JSON.stringify(args)}`
}

export class Client extends EventEmitter {
  options: any
  accessToken: string | null = null
  refreshToken: string | null = null
  clientId: string | null = null
  application: Application | null = null
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
    this.transport.on('message', this._onRpcMessage.bind(this))
  }

  async fetch(method: string, path: string, { data, query }: any = {}): Promise<any> {
    return fetch(`${this.endpoint}${path}${query ? new URLSearchParams(query) : ''}`, {
      method,
      body: data,
      headers: {
        Authorization: `Bearer ${this.accessToken}`
      }
    }).then(async (res) => {
      const body = await res.json()

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
      return this._connectPromise
    }

    this._connectPromise = new Promise((resolve, reject) => {
      this.clientId = clientId

      const timeout = setTimeout(() => reject(new Error('RPC_CONNECTION_TIMEOUT')), 10e3)
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
    await this.connect(options.clientId)

    if (!options.scopes) {
      this.emit('ready')
      return this
    }

    if (options.refreshToken) {
      const auth = await this.refreshOAuthToken(options)
      if (auth !== null) {
        options.accessToken = auth.access_token
        options.refreshToken = auth.refresh_token
        this.accessToken = auth.access_token
        this.refreshToken = auth.refresh_token
      } else {
        options.accessToken = undefined
        options.refreshToken = undefined
      }
    }

    if (!options.accessToken || !options.refreshToken) {
      let auth = await this.authorize(options)
      options.accessToken = auth.access_token
      options.refreshToken = auth.refresh_token
      this.accessToken = auth.access_token
      this.refreshToken = auth.refresh_token
    }

    return this.authenticate(options)
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
      rpc_token: rpcToken
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

    return response
  }

  /**
   * Authenticate
   * @param {string} accessToken access token
   * @returns {Promise}
   * @private
   */
  authenticate(options: RPCLoginOptions) {
    return this.request('AUTHENTICATE', { access_token: options.accessToken }).then(({ application, user }: any) => {
      this.accessToken = options.accessToken as string
      this.refreshToken = options.refreshToken as string
      this.application = application
      this.user = user
      this.emit('ready')
      return this
    })
  }

  /**
   * Refresh access tokens
   * @param {RPCLoginOptions} options
   * @returns {Promise<RefreshTokenResponse | null>}
   */
  refreshOAuthToken(options: RPCLoginOptions): Promise<RefreshTokenResponse | null> {
    return fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret || '',
        grant_type: 'refresh_token',
        refresh_token: options.refreshToken || ''
      })
    })
      .then((res) => res.json())
      .catch((_err) => {
        return null
      }) as Promise<RefreshTokenResponse | null>
  }

  /**
   * Fetch a guild
   * @param {Snowflake} id Guild ID
   * @param {number} [timeout] Timeout request
   * @returns {Promise<Guild>}
   */
  getGuild(id: string, timeout?: number): Promise<Guild> {
    return this.request(RPCCommands.GET_GUILD, { guild_id: id, timeout }) as Promise<Guild>
  }

  /**
   * Fetch all guilds
   * @param {number} [timeout] Timeout request
   * @returns {Promise<Partial<Guild>[]>}
   */
  async getGuilds(timeout?: number) {
    const { guilds } = (await this.request(RPCCommands.GET_GUILDS, { timeout })) as Guilds

    return guilds
  }

  /**
   * Get a channel
   * @param {Snowflake} id Channel ID
   * @param {number} [timeout] Timeout request
   * @returns {Promise<Channel>}
   */
  getChannel(id: string, timeout?: number): Promise<Channel> {
    return this.request(RPCCommands.GET_CHANNEL, { channel_id: id, timeout }) as Promise<Channel>
  }

  /**
   * Get all channels
   * @param {Snowflake} [id] Guild ID
   * @param {number} [timeout] Timeout request
   * @returns {Promise<ChannelsResponse[]>}
   */
  async getChannels(id?: string, timeout?: number): Promise<ChannelsResponse[]> {
    const { channels } = (await this.request(RPCCommands.GET_CHANNELS, { guild_id: id, timeout })) as Channels

    return channels
  }

  /**
   * Get voice channel currently connected to
   * @returns {Promise<Channel | null>}
   */
  async getSelectedVoiceChannel(): Promise<Channel | null> {
    return this.request(RPCCommands.GET_SELECTED_VOICE_CHANNEL) as Promise<Channel | null>
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
   * @returns {Promise<UserVoiceSettings>}
   */
  setUserVoiceSettings(id: string, settings: Partial<UserVoiceSettings>): Promise<UserVoiceSettings> {
    return this.request(RPCCommands.SET_USER_VOICE_SETTINGS, {
      user_id: id,
      ...settings
    }) as Promise<UserVoiceSettings>
  }

  /**
   * Move the user to a voice channel
   * @param {Snowflake} id ID of the voice channel
   * @param {Object} [options] Options
   * @param {number} [options.timeout] Timeout for the command
   * @param {boolean} [options.force] Force this move. This should only be done if you
   * have explicit permission from the user.
   * @returns {Promise<Channel>}
   */
  selectVoiceChannel(id: string | null, { timeout, force = false }: any = {}): Promise<Channel> {
    return this.request(RPCCommands.SELECT_VOICE_CHANNEL, { channel_id: id, timeout, force }) as Promise<Channel>
  }

  /**
   * Move the user to a text channel
   * @param {Snowflake} id ID of the voice channel
   * @param {Object} [options] Options
   * @param {number} [options.timeout] Timeout for the command
   * have explicit permission from the user.
   * @returns {Promise<Channel>}
   */
  selectTextChannel(id: string, { timeout }: any = {}): Promise<Channel> {
    return this.request(RPCCommands.SELECT_TEXT_CHANNEL, { channel_id: id, timeout }) as Promise<Channel>
  }

  /**
   * Get current voice settings
   * @returns {Promise<VoiceSettings>}
   */
  getVoiceSettings(): Promise<VoiceSettings> {
    return this.request(RPCCommands.GET_VOICE_SETTINGS) as Promise<VoiceSettings>
  }

  /**
   * Set current voice settings, overriding the current settings until this session disconnects.
   * This also locks the settings for any other rpc sessions which may be connected.
   * @param {Partial<VoiceSettings>} args Settings
   * @returns {Promise<VoiceSettings>}
   */
  setVoiceSettings(args: Partial<VoiceSettings>): Promise<VoiceSettings> {
    return this.request(RPCCommands.SET_VOICE_SETTINGS, args) as Promise<VoiceSettings>
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
    const subid = subKey(RPCEvents.CAPTURE_SHORTCUT_CHANGE)

    const stop = () => {
      this._subscriptions.delete(subid)
      return this.request(RPCCommands.CAPTURE_SHORTCUT, { action: 'STOP' })
    }

    this._subscriptions.set(subid, ({ shortcut }: any) => {
      callback(shortcut, stop)
    })

    return this.request(RPCCommands.CAPTURE_SHORTCUT, { action: 'START' }).then(() => stop)
  }

  /**
   * Sets the presence for the logged in user.
   * @param {object} args The rich presence to pass.
   * @param {number} [pid] The application's process ID. Defaults to the executing process' PID.
   * @returns {Promise<Activity>}
   */
  setActivity(args: any = {}): Promise<Activity> {
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
      }
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
    }) as Promise<Activity>
  }

  /**
   * Clears the currently set presence, if any. This will hide the "Playing X" message
   * displayed below the user's name.
   * @param {number} [pid] The application's process ID. Defaults to the executing process' PID.
   * @returns {Promise<null>}
   */
  clearActivity(): Promise<null> {
    return this.request(RPCCommands.SET_ACTIVITY, { pid: process.pid }) as Promise<null>
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
      user_id: user.id || user
    })
  }

  /**
   * Reject a join request from a user
   * @param {User} user The user whose request you wish to reject
   * @returns {Promise}
   */
  closeJoinRequest(user: any) {
    return this.request(RPCCommands.CLOSE_ACTIVITY_JOIN_REQUEST, {
      user_id: user.id || user
    })
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
    return this.request(RPCCommands.DELETE_LOBBY, { id: lobby.id || lobby })
  }

  connectToLobby(id: any, secret: any) {
    return this.request(RPCCommands.CONNECT_TO_LOBBY, { id, secret })
  }

  sendToLobby(lobby: any, data: any) {
    return this.request(RPCCommands.SEND_TO_LOBBY, { id: lobby.id || lobby, data })
  }

  disconnectFromLobby(lobby: any) {
    return this.request(RPCCommands.DISCONNECT_FROM_LOBBY, { id: lobby.id || lobby })
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

    return this.request(RPCCommands.GET_RELATIONSHIPS).then((res: any) => {
      return res.relationships.map((relationship: any) => ({
        ...relationship,
        type: types[relationship.type]
      }))
    })
  }

  /**
   * Subscribe to an event
   * @param {string} event Name of event e.g. `MESSAGE_CREATE`
   * @param {Object} [args] Args for event e.g. `{ channel_id: '1234' }`
   * @returns {Promise<Subscription>}
   */
  async subscribe(event: string, args?: any): Promise<Subscription> {
    await this.request(RPCCommands.SUBSCRIBE, args, event)

    return {
      unsubscribe: () => this.request(RPCCommands.UNSUBSCRIBE, args, event)
    }
  }

  /**
   * Destroy the client
   */
  async destroy() {
    this._expecting.clear()
    await this.transport.close()
  }
}
