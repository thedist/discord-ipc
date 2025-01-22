import net from 'net'
import EventEmitter from 'events'
import { Client } from './client';
import { uuid } from './utils'

const OPCodes = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4,
};

const getIPCPath = (id: number) => {
  if (process.platform === 'win32') {
    return `\\\\?\\pipe\\discord-ipc-${id}`
  }

  const { env: { XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP } } = process
  const prefix = XDG_RUNTIME_DIR || TMPDIR || TMP || TEMP || '/tmp'

  return `${prefix.replace(/\/$/, '')}/discord-ipc-${id}`
}

const getIPC = (id = 0): Promise<net.Socket> => {
  return new Promise((resolve, reject) => {
    const path = getIPCPath(id)

    const onerror = () => {
      if (id < 10) {
        resolve(getIPC(id + 1))
      } else {
        reject(new Error('Could not connect'))
      }
    }

    const sock = net.createConnection(path, () => {
      sock.removeListener('error', onerror)
      resolve(sock)
    })

    sock.once('error', onerror)
  })
}

const findEndpoint = async (tries = 0) => {
  if (tries > 30) {
    throw new Error('Could not find endpoint')
  }

  const endpoint = `http://127.0.0.1:${6463 + (tries % 10)}`

  try {
    const res = await fetch(endpoint)
    if (res.status === 404) {
      return endpoint
    }
    return findEndpoint(tries + 1)
  } catch (e) {
    return findEndpoint(tries + 1)
  }
}

export const encode = (op: number, data: any): Buffer => {
  data = JSON.stringify(data)
  const len = Buffer.byteLength(data)
  const packet = Buffer.alloc(8 + len)
  packet.writeInt32LE(op, 0)
  packet.writeInt32LE(len, 4)
  packet.write(data, 8, len)
  return packet
}

const working = {
  full: '',
  op: undefined,
}

export const decode = (socket: net.Socket, callback: any) => {
  const packet = socket.read()

  if (!packet) return

  let { op } = working

  let raw
  if (working.full === '') {
    op = working.op = packet.readInt32LE(0)
    const len = packet.readInt32LE(4)
    raw = packet.slice(8, len + 8)
  } else {
    raw = packet.toString()
  }

  try {
    const data = JSON.parse(working.full + raw);
    callback({ op, data })
    working.full = ''
    working.op = undefined
  } catch (err) {
    working.full += raw
  }

  decode(socket, callback)
}

export class IPCTransport extends EventEmitter {
  client: Client
  socket: net.Socket | null = null

  constructor(client: Client) {
    super();
    this.client = client
  }

  async connect() {
    const socket = this.socket = await getIPC()

    socket.on('close', this.onClose.bind(this))
    socket.on('error', this.onClose.bind(this))

    this.emit('open')

    socket.write(encode(OPCodes.HANDSHAKE, {
      v: 1,
      client_id: this.client.clientId,
    }))

    socket.pause()

    socket.on('readable', () => {
      decode(socket, ({ op, data }: any) => {
        if (op === OPCodes.PING) {
          this.send(data, OPCodes.PONG)
        } else if (op === OPCodes.FRAME) {
          if (!data) return

          if (data.cmd === 'AUTHORIZE' && data.evt !== 'ERROR') {
            findEndpoint()
              .then((endpoint) => {
                this.client.endpoint = endpoint
              })
              .catch((err) => {
                this.client.emit('error', err)
              })
          }

          this.emit('message', data)
        } else if (op === OPCodes.CLOSE) {
          this.emit('close', data)
        }
      })
    })
  }

  onClose(err: Error) {
    this.emit('close', err)
  }

  send(data: any, op = OPCodes.FRAME) {
    this.socket?.write(encode(op, data))
  }

  async close() {
    return new Promise((resolve) => {
      this.once('close', resolve)
      this.send({}, OPCodes.CLOSE)
      this.socket?.end()
    });
  }

  ping() {
    this.send(uuid(), OPCodes.PING)
  }
}
