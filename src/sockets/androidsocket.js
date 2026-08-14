const net = require('net');
const EventEmitter = require('events');

/**
 * Common socket class for ADBSocket and JDWPSocket
 */
class AndroidSocket extends EventEmitter {
    constructor(which) {
        super()
        this.which = which;
        this.socket = null;
        this.socket_error = null;
        this.socket_ended = false;
        this.readbuffer = Buffer.alloc(0);
    }

    connect(port, hostname) {
        const stackOnError = new Error().stack;
        return new Promise((resolve, reject) => {
            if (this.socket) {
                return reject(new Error(`${this.which} Socket connect failed. Socket already connected. ${stackOnError}`));
            }
            // reset per-connection state - these are instance-level and must not
            // leak across repeated connect/disconnect cycles (a stale
            // socket_ended from an old socket would make the new socket's reads
            // fail immediately, and a stale socket_disconnecting would make
            // disconnect() return a never-resolving promise)
            this.socket_ended = false;
            this.socket_error = null;
            this.readbuffer = Buffer.alloc(0);
            this.removeAllListeners('data-changed');
            this.removeAllListeners('socket-ended');
            this.socket_disconnecting = null;
            const connection_error = err => {
                return reject(new Error(`${this.which} Socket connect failed. ${err.message}. ${stackOnError}`));
            }
            const post_connection_error = err => {
                this.socket_error = err;
                this.socket.end();
            }
            let error_handler = connection_error;
            this.socket = new net.Socket()
                .once('connect', () => {
                    clearTimeout(connect_timer);
                    error_handler = post_connection_error;
                    this.socket
                        .on('data', buffer => {
                            this.readbuffer = Buffer.concat([this.readbuffer, buffer]);
                            this.emit('data-changed');
                        })
                        .once('end', () => {
                            this.socket_ended = true;
                            this.emit('socket-ended');
                            if (!this.socket_disconnecting) {
                                this.socket_disconnecting = this.socket_error ? Promise.reject(this.socket_error) : Promise.resolve();
                            }
                        });
                    resolve();
                })
                .on('error', err => error_handler(err));
            // guard against a hung connect (e.g. adb server not answering);
            // never block the debug session forever on a dead local port
            const connect_timer = setTimeout(() => {
                this.socket.destroy();
                reject(new Error(`${this.which} Socket connect failed. Connection timed out. ${stackOnError}`));
            }, 10000);
            // for some reason if hostname is left blank, it will sometimes return ECONNREFUSED
            this.socket.connect(port, hostname || '127.0.0.1');
        });
    }

    disconnect() {
        if (this.socket_disconnecting) {
            return this.socket_disconnecting;
        }
        this.socket_disconnecting = new Promise(resolve => {
            try {
                this.socket && this.socket.end();
            } catch (e) { /* already gone */ }
            this.socket = null;
            // resolve when the socket fully closes (or immediately if it
            // already ended - e.g. repeated disconnect calls)
            if (this.socket_ended) {
                resolve();
            } else {
                this.once('socket-ended', resolve);
            }
        });
        return this.socket_disconnecting;
    }

    /**
     * 
     * @param {number|'length+data'|undefined} length 
     * @param {string} [format] 
     * @param {number} [timeout_ms]
     */
    async read_bytes(length, format, timeout_ms) {
        //D(`reading ${length} bytes`);
        let actual_length = undefined;
        if (typeof length === 'undefined') {
            if (this.readbuffer.byteLength > 0 || this.socket_ended) {
                actual_length = this.readbuffer.byteLength;
            }
        }
        if (length === 'length+data' && this.readbuffer.byteLength >= 4) {
            length = actual_length = this.readbuffer.readUInt32BE(0);
        }
        if (typeof length === 'number') {
            actual_length = length;
        }
        if (actual_length < 0) {
            throw new Error(`${this.which} socket read failed. Attempt to read ${actual_length} bytes.`);
        }
        if (this.socket_ended) {
            // EOF: for "read whatever is available" (stdout) reads this is
            // normal - a command that produced no output closes the socket.
            // For fixed-length reads it is an error (truncated reply).
            if (typeof length === 'undefined') {
                actual_length = this.readbuffer.byteLength;
            } else if (actual_length <= 0 || (this.readbuffer.byteLength < actual_length)) {
                this.check_socket_active('read');
            }
        }
        // do we have enough data in the buffer?
        if (this.readbuffer.byteLength >= actual_length) {
            //D(`got ${actual_length} bytes`);
            const data = this.readbuffer.slice(0, actual_length);
            this.readbuffer = this.readbuffer.slice(actual_length);
            const result = format ? data.toString(format) : data;
            return Promise.resolve(result);
        }
        // wait for the socket to update and then retry the read
        // (pass the timeout down - otherwise a partial read recurses forever)
        try {
            await this.wait_for_socket_data(timeout_ms);
        } catch (err) {
            // EOF while reading stdout (e.g. 'am force-stop' produces no
            // output, so the adb server closes the socket) is normal - return
            // an empty result instead of failing the whole command.
            if (typeof length === 'undefined' && /Socket closed/i.test(err.message)) {
                return format ? Buffer.alloc(0).toString(format) : Buffer.alloc(0);
            }
            throw err;
        }
        return this.read_bytes(length, format, timeout_ms);
    }

    /**
     * 
     * @param {number} [timeout_ms] 
     */
    wait_for_socket_data(timeout_ms) {
        return new Promise((resolve, reject) => {
            // if the socket is already closed, there's nothing to wait for -
            // fail fast instead of hanging forever (e.g. a shell command with
            // no output where the EOF race lost against this call)
            if (this.socket_ended) {
                return reject(new Error(`${this.which} socket read failed. Socket closed.`));
            }
            // data may already be buffered (a 'data-changed' event fired while
            // no reader was waiting and got dropped) - don't block on that
            if (this.readbuffer.byteLength > 0) {
                return resolve();
            }
            let done = 0, timer = null;
            let onDataChanged = () => {
                if ((done += 1) !== 1) return;
                this.off('socket-ended', onSocketEnded);
                clearTimeout(timer);
                resolve();
            }
            let onSocketEnded = () => {
                if ((done += 1) !== 1) return;
                this.off('data-changed', onDataChanged);
                clearTimeout(timer);
                reject(new Error(`${this.which} socket read failed. Socket closed.`));
            }
            let onTimerExpired = () => {
                if ((done += 1) !== 1) return;
                this.off('socket-ended', onSocketEnded);
                this.off('data-changed', onDataChanged);
                reject(new Error(`${this.which} socket read failed. Read timeout.`));
            }
            this.once('data-changed', onDataChanged);
            this.once('socket-ended', onSocketEnded);
            if (typeof timeout_ms === 'number' && timeout_ms >= 0) {
                timer = setTimeout(onTimerExpired, timeout_ms);
            }
        });
    }

    async read_le_length_data(format) {
        const len = await this.read_bytes(4);
        return this.read_bytes(len.readUInt32LE(0), format);
    }

    /**
     * 
     * @param {number} [timeout_ms] 
     * @param {boolean} [until_closed] 
     * @returns {Promise<Buffer>}
     */
    async read_stdout(timeout_ms, until_closed) {
        let buf = await this.read_bytes(undefined, null, timeout_ms);
        if (!until_closed) {
            return buf;
        }
        const parts = [buf];
        // bound the whole drain so a wedged adb/device can't hang us forever
        const deadline = Date.now() + 30000;
        try {
            for (;;) {
                // the socket is already ended - no more data will ever arrive
                if (this.socket_ended || Date.now() > deadline) {
                    break;
                }
                buf = await this.read_bytes(undefined, null);
                parts.push(buf);
            }
        } catch {
        }
        return Buffer.concat(parts);
    }

    /**
     * Writes a raw command to the socket
     * @param {string|Buffer} bytes 
     */
    write_bytes(bytes) {
        return new Promise((resolve, reject) => {
            this.check_socket_active('write');
            try {
                // @ts-ignore
                const flushed = this.socket.write(bytes, () => {
                    flushed ? resolve() : this.socket.once('drain', resolve);
                });
            } catch (e) {
                this.socket_error = e;
                reject(new Error(`${this.which} socket write failed. ${e.message}`));
            }
        });
    }

    /**
     * 
     * @param {'read'|'write'} action 
     */
    check_socket_active(action) {
        if (this.socket_ended) {
            throw new Error(`${this.which} socket ${action} failed. Socket closed.`);
        }

    }
}

module.exports = AndroidSocket;
