// 站点解析进程级夹具：按入参执行 resolveSite（或显式目录模式），打印解析结果后退出；
// hold: true 时持有解析所得端口并以合法 probe-ack 应答——模拟「运行中的站点」，
// 供并发启动、崩溃抢占、自愈序列等进程级用例在真实套接字上驱动槽位搜索。
import dgram from 'node:dgram';
import { ensureDir } from '../../src/paths.js';
import { loadOrCreateInstanceId } from '../../src/instance-id.js';
import { PROTOCOL_VERSION } from '../../src/net/protocol.js';
import { resolveSite } from '../../src/site.js';

const options = JSON.parse(process.argv[2]);
const env = options.explicitDir ? { WAYSTATION_HOME: options.explicitDir } : {};
const site = await resolveSite({
  env,
  mainDir: options.mainDir,
  segmentBase: options.segmentBase,
  probeTimeoutMs: options.probeTimeoutMs ?? 600,   // 判定预算：300ms 在负载下偏紧（UDP 半预算 150ms 抖动 → 驿站被误判为无关程序）
  warn: (message) => {
    process.stderr.write(`warn: ${message}\n`);
  },
});

if (!site.ok) {
  process.stdout.write(JSON.stringify(site) + '\n');
  process.exit(0);
}

let instanceId = '';
try {
  ensureDir(site.dataDir);
  instanceId = loadOrCreateInstanceId(site.dataDir);
} catch (error) {
  process.stdout.write(JSON.stringify({ ...site, instanceId, instanceIdError: error.message }) + '\n');
  process.exit(0);
}

if (options.hold) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ port: site.port, address: '0.0.0.0', exclusive: true }, resolve);
  });
  socket.on('message', (buffer, rinfo) => {
    const datagram = JSON.parse(buffer.toString('utf8'));
    if (datagram.type !== 'probe') {
      return;
    }
    const ack = Buffer.from(JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'probe-ack',
      instanceId,
      identityName: options.identityName ?? '解析夹具站点',
      collabCount: 0,
      port: site.port,
    }));
    socket.send(ack, rinfo.port, rinfo.address);
  });
}

process.stdout.write(JSON.stringify({ ...site, instanceId }) + '\n');
