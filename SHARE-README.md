# FundInsight 分享版

## 首次启动

安装 Node.js 18 或更高版本，在此目录执行 `npm ci`。

启动前设置以下环境变量，所有值均由接收者自行生成，不使用原项目凭据：

| 变量 | 要求 |
| --- | --- |
| `ACCESS_PASSWORD` | 必填，前台访问密码；未设置时程序拒绝启动。 |
| `ADMIN_PASSWORD` | 建议设置独立强密码。未设置时首次启动生成随机密码，存入 `data/admin-password.txt`，仅在服务器查看。 |
| `ACCESS_SECRET` | 建议设置持久的高强度随机串。未设置时每次启动使用随机值，重启会使已有前台会话失效。 |
| `PUBLIC_ORIGIN` | 公网部署设为自己的完整站点来源，例如 `https://example.com`，不带路径。 |
| `COOKIE_SECURE` | HTTPS 部署设为 `1`；本地 HTTP 测试不设置。 |

可以在宝塔 Node 项目、进程管理器或终端中设置环境变量。程序不会自动读取 `.env`，不要只创建该文件而不将变量注入进程。

配置完环境变量后执行：

```sh
npm start
```

默认地址为 `http://localhost:3210`，管理后台为 `/admin`。基础行情功能不需要模型 Key；
AI 默认关闭，在后台填入自己的模型和搜索渠道配置后再启用。

## 验证与再分享

```sh
npm run check
npm test
```