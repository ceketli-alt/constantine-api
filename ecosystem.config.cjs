module.exports = {
  apps: [
    {
      name: 'api-constantine',
      cwd: '/var/www/api/apps/constantine',
      script: '/var/www/api/node_modules/.bin/tsx',
      args: 'src/server.ts',
      interpreter: 'none',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      out_file: '/var/log/api-constantine.out.log',
      error_file: '/var/log/api-constantine.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
