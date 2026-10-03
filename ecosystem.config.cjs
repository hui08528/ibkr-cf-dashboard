module.exports = {
  apps: [
    {
      name: "ibkr-dashboard",
      script: "server.js",
      cwd: __dirname,
      // 单实例 fork：模块级缓存只在进程内，cluster 多进程会把上游 API 调用放大 N 倍
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "5s",
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        HOST: "127.0.0.1",
      },
      out_file: "/var/log/ibkr-dashboard/out.log",
      error_file: "/var/log/ibkr-dashboard/error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
