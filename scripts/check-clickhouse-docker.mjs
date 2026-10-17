import { spawnSync } from 'node:child_process';

const options = {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 10_000,
};

const cli = spawnSync('docker', ['--version'], options);
if (cli.error || cli.status !== 0) {
  console.error(
    'ClickHouse fixture setup: Docker CLI is unavailable. Install Docker Desktop or Docker Engine and make sure `docker --version` works in this terminal.',
  );
  process.exitCode = 1;
} else {
  const daemon = spawnSync('docker', ['info'], options);
  if (daemon.error || daemon.status !== 0) {
    console.error(
      'ClickHouse fixture setup: Docker daemon is not running or is unreachable. Start Docker Desktop or the Docker Engine service, check your Docker context and permissions, and make sure `docker info` succeeds before retrying.',
    );
    process.exitCode = 1;
  }
}
