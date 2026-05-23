module.exports = {
  apps: [{
    name: 'crm-new',
    script: '/usr/bin/serve',
    args: '-s /var/www/crm-new/dist -l 8011',
    interpreter: 'none',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '256M',
    autorestart: true,
    out_file: '/var/log/crm-new.out.log',
    error_file: '/var/log/crm-new.err.log',
    merge_logs: true,
    time: true,
  }]
};
