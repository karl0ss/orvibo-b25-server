const net = require('net');
const util = require('util');
const Packet = require('./OrviboPacket');
const PacketBuilder = require('./PacketBuilder');
const Utils = require('./Utils');
const Settings = require('./OrviboSettings');
const EventEmitter = require('events').EventEmitter;

const ORVIBO_KEY = Settings.ORVIBO_KEY;
const LOG_PACKET = Settings.LOG_PACKET;

if (ORVIBO_KEY === '') {
    console.log('Please add Orvibo PK key to OrviboSettings.js file. See Readme');
    process.exit(1);
}

const Orvibo = function() {};

Object.assign(Orvibo.prototype, EventEmitter.prototype);

let HEARTBEAT = 32;
let HELLO = 0;
let HANDSHAKE = 6;
let STATE_UPDATE = 42;
let STATE_UPDATE_CONFIRM = 15;
let UNKNOWN_CMD = 'UNKNOWN_CMD';

let port = 10001;
let bindHost = '0.0.0.0';

console.log(`Starting server Orvibo socket server on port ${port}`);

let plugConnections = [];
let packetData = {};

// Put your smart socket data here and it will be matched to the uid
let plugInfo = Settings.plugInfo;

let getNameForUid = (uid) => {
    let item = plugInfo.find(item => item.uid === uid);
    return item != null ? item.name : 'unknown';
};

let getData = (id) => {
    return packetData[id];
};

let setData = (id, data) => {
    packetData[id] = data;
};

let respondAndSetData = (data, socket, packetFunction) => {
    setData(socket.id, data);
    socket.write(packetFunction(data));
};

let helloHandler = (plugPacket, socket) => {
    let pkData = {
        serial: plugPacket.getSerial(),
        encryptionKey: Utils.generateRandomTextValue(16),
        id: Utils.generateRandomHexValue(32),
        modelId: plugPacket.getModelId(),
    };
    respondAndSetData(pkData, socket, PacketBuilder.helloPacket);
};

let handshakeHandler = function(plugPacket, socket, socketData) {
    let uid = plugPacket.getUid();
    let pkData = Object.assign({}, socketData, {
        serial: plugPacket.getSerial(),
        uid,
        name: getNameForUid(uid)
    });
    respondAndSetData(pkData, socket, PacketBuilder.handshakePacket);
    this.emit('plugConnected', {uid:pkData.uid, name: pkData.name});
};

let heartbeatHandler = function(plugPacket, socket, socketData) {
    let pkData = Object.assign({}, socketData, {
        serial: plugPacket.getSerial(),
        uid: plugPacket.getUid()
    });
    respondAndSetData(pkData, socket, PacketBuilder.heartbeatPacket);
    this.emit('gotHeartbeat', {uid:pkData.uid, name: pkData.name});
};

let stateUpdateHandler = function(plugPacket, socket, socketData) {
    let pkData = Object.assign({}, socketData, {
        serial: plugPacket.getSerial(),
        uid: plugPacket.getUid(),
        state: plugPacket.getValue1()
    });
    respondAndSetData(pkData, socket, PacketBuilder.comfirmStatePacket);
    this.emit('plugStateUpdated', {uid:pkData.uid, state: pkData.state, name: pkData.name});
};

let stateConfirmHandler = function() {
    // Do nothing at this stage
};

let unknownCmdHandler = function(plugPacket, socket, socketData) {
    let pkData = Object.assign({}, socketData, {
        serial: plugPacket.getSerial(),
        uid: plugPacket.getUid(),
    });
    respondAndSetData(pkData, socket, PacketBuilder.defaultPacket);
};

Orvibo.prototype.handlers = function() {
    return {
        [HELLO]: helloHandler.bind(this),
        [HANDSHAKE]: handshakeHandler.bind(this),
        [HEARTBEAT]: heartbeatHandler.bind(this),
        [STATE_UPDATE]: stateUpdateHandler.bind(this),
        [STATE_UPDATE_CONFIRM] : stateConfirmHandler,
        [UNKNOWN_CMD]: unknownCmdHandler.bind(this)
    };
};

Orvibo.prototype.startServer = function() {

    let self = this;

    let handlers = this.handlers();

    this.server = net.createServer(function(socket) {

        socket.id = Utils.generateRandomTextValue(16);
        socket.setKeepAlive(true, 10000);
        plugConnections.push(socket);

        socket.on('data', function (data) {

            let socketData = getData(socket.id);
            let plugPacket = new Packet(data);

            if (!plugPacket.validCRC()) {
                console.log('Got invalid CRC');
                return;
            }

            if (plugPacket.packetTypeText() === 'pk') {
                plugPacket.processPacket(ORVIBO_KEY);
            } else {
                plugPacket.processPacket(socketData.encryptionKey);
            }

            LOG_PACKET && plugPacket.logPacket("Socket -> ");

            let handler = handlers[plugPacket.getCommand()];
            if (handler != null) {
                handler(plugPacket, socket, socketData);
            } else {
                handlers[UNKNOWN_CMD](plugPacket, socket, socketData);
            }
        });

        socket.on('end', function () {
            let pkData = getData(socket.id);
            self.emit('plugDisconnected', {uid: pkData.uid, name: pkData.name});
            delete packetData[socket.id];
            plugConnections.splice(plugConnections.indexOf(socket), 1);
        });

        socket.on('error', (err) => {
            console.log(err);
            console.log('error with socket ' + socket.id);
            self.emit('plugDisconnectedWithError', getData(socket.id));
            delete packetData[socket.id];
            plugConnections.splice(plugConnections.indexOf(socket), 1);

        });

    });

    this.server.listen(port, bindHost);
};

Orvibo.prototype.toggleSocket = function(uid) {

    let socketId = null;
    for (const key of Object.keys(packetData)) {
        if (packetData[key].uid === uid) {
            socketId = key;
            break
        }
    }
    if (socketId === null) {
        console.log('Could not find socket ' + uid);
        return;
    }
    let socket = plugConnections.find(s => s.id === socketId);
    if (socket != null) {
        let socketData = getData(socketId);
        let data = Object.assign({}, socketData,{
            state: socketData.state === 1 ? 0 : 1,
            serial: Utils.generateRandomNumber(8),
            clientSessionId:  socketData.clientSessionId ? socketData.clientSessionId : Utils.generateRandomHexValue(32),
            deviceId: socketData.deviceId ? socketData.deviceId : Utils.generateRandomHexValue(32),
        });

        setData(socket.id, data);

        let packet = PacketBuilder.updatePacket(data);
        socket.write(packet);

    } else {
        console.log('Can not find socket ');
    }
};

Orvibo.prototype.getConnectedSocket = function() {
    let sockets = [];
    for (const key of Object.keys(packetData)) {
        let socketData = getData(key);
        sockets.push({
            name: socketData.name,
            state: socketData.state,
            uid: socketData.uid,
            modelId: socketData.modelId
        });
    }
    return sockets;
};

module.exports = Orvibo;