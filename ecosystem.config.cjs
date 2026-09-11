// PM2 process definition for the Forecast Arena web app.
//
//   pm2 start ecosystem.config.cjs && pm2 save
//
// `pm2 save` writes ~/.pm2/dump.pm2, and the enabled pm2-mdlog.service replays
// that dump on boot, so the app comes back after a reboot without a human.
//
// The interpreter is pinned to an absolute path on purpose: pm2-mdlog.service
// carries its own PATH (which still points at node v22.10.0), so relying on
// `node` resolving off PATH would give the boot-time process a different
// runtime than the one this app is built and tested against. node:sqlite is
// version-sensitive enough that the drift would surface as a boot-only failure.
module.exports = {
  apps: [
    {
      name: "somnia-forecast-arena",
      cwd: __dirname,
      // Call Next's bin directly rather than through `npm start`: npm would sit
      // in the middle as a shell parent, and pm2 restart/stop would signal the
      // wrapper instead of the server.
      script: "node_modules/next/dist/bin/next",
      // 3009 is the origin the Cloudflare tunnel for meta-agent.mdloglabs.org
      // dials; the README uses it throughout too. Serving anywhere else
      // returns 502 at the public hostname no matter how healthy the app is.
      args: "start -p 3009",
      interpreter: "/home/mdlog/.nvm/versions/node/v22.23.1/bin/node",
      exec_mode: "fork",
      instances: 1,

      env: {
        NODE_ENV: "production",
        PORT: "3009",
      },

      autorestart: true,
      restart_delay: 4000,
      max_restarts: 10,
      // A process that dies inside 30s counts as a failed boot, not a restart,
      // so a crash loop stops instead of spinning.
      min_uptime: "30s",
      max_memory_restart: "1G",
      // Next needs a moment to drain in-flight requests before SIGKILL.
      kill_timeout: 5000,

      out_file: ".data/logs/pm2-app-out.log",
      error_file: ".data/logs/pm2-app-error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
