#!/usr/bin/env node
// A home base for a HomeCircle server that isn't at home (Render, a VPS):
// run this on any computer at home next to a Meshtastic node. It forwards
// HomeCircle tracker packets the node hears to the server over HTTPS. It
// can't read them, and needs no account: each packet proves its sender.
//
//   node server/scripts/mesh-bridge.mjs --node tcp://192.168.1.60:4403 --server https://homecircle.example.com
//   node server/scripts/mesh-bridge.mjs --node serial:/dev/ttyUSB0 --server https://homecircle.example.com
//
// A server at home (Docker, Home Assistant, a Pi) can do this itself: set
// MESH_NODE to the same link and leave this script out.
import { parseArgs } from 'node:util';
import { startMeshBridge } from '../src/meshtastic.js';

const { values } = parseArgs({ options: { node: { type: 'string' }, server: { type: 'string' } } });
if (!values.node || !values.server) {
  console.error('usage: mesh-bridge.mjs --node tcp://HOST:4403|serial:/dev/ttyUSB0 --server https://your-server');
  process.exit(2);
}
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const bridge = startMeshBridge({ node: values.node, server: values.server, log });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (bridge.stop(), process.exit(0)));
