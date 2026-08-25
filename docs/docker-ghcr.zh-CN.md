[English](docker-ghcr.md) | [简体中文](docker-ghcr.zh-CN.md)

# Docker 镜像（Docker Hub）

本 fork 将预构建的 Docker 镜像发布到我们自己的 Docker Hub 账号（而非上游项目的 GHCR），你无需克隆仓库或自己构建即可
运行 OpenConnector。镜像地址为：

```text
docker.io/REPLACE_WITH_DOCKERHUB_USERNAME/open-connector
```

请将 `REPLACE_WITH_DOCKERHUB_USERNAME` 替换为仓库 `DOCKERHUB_USERNAME` Actions 变量中配置的 Docker Hub
用户名/组织（参见本文末尾的“镜像如何发布”一节）。如果镜像是私有的，请先 `docker login`。

## 选择标签（Tag）

| 标签                | 指向                             | 适用场景                               |
| ------------------- | -------------------------------- | -------------------------------------- |
| `latest`            | 最新发布的 release               | 想要当前的稳定 runtime                 |
| `<release-version>` | 某个具体 release（不可变）       | 部署到生产环境，需要固定、可复现的构建 |
| `tip`               | `main` 上的最新 commit           | 想体验尚未发布的改动                   |
| `<short-sha>`       | 某个具体 `main` commit（不可变） | 想固定到某个确切的预发布构建           |

生产环境请固定到某个具体的 release 版本，不要使用 `latest`。

## 拉取

如果 Docker Hub 仓库是 public 的，无需登录即可拉取：

```bash
docker pull docker.io/REPLACE_WITH_DOCKERHUB_USERNAME/open-connector:latest
```

如果仓库是私有的，或遇到 `unauthorized` 或 `denied` 错误，请先用 Docker Hub access token 登录：

```bash
echo "$DOCKERHUB_TOKEN" | docker login -u <dockerhub-username> --password-stdin
```

镜像是多架构的（`linux/amd64` + `linux/arm64`），Docker 会自动拉取与你机器匹配的那个变体——在 Intel/AMD
主机和 arm64 主机（如 Apple Silicon、AWS Graviton）上都是原生运行，无需 `--platform` 参数。

## 运行

镜像监听 `3000` 端口，绑定到 `0.0.0.0`，并把运行时数据存放在 `/app/data`。

先生成运行时 secret 并妥善保存。`OOMOL_CONNECT_ENCRYPTION_KEY` 用于加密存储的凭据、OAuth client 配置和已完成的
幂等 Action 响应；一旦丢失，`/app/data` 里加密的数据将无法恢复。`OOMOL_CONNECT_ADMIN_TOKEN` 用于 admin API 和
控制台的鉴权。

```bash
# 运行前请把两个值保存到密码管理器或 secrets vault。
export OOMOL_CONNECT_ENCRYPTION_KEY=$(openssl rand -base64 32)
export OOMOL_CONNECT_ADMIN_TOKEN=$(openssl rand -base64 32)
```

然后运行镜像，并挂载 volume 让数据在重启后保留：

```bash
docker run -d \
  --name open-connector \
  -p 3000:3000 \
  -v open_connector_data:/app/data \
  -e OOMOL_CONNECT_ORIGIN="https://api.example.com" \
  -e OOMOL_CONNECT_ENCRYPTION_KEY="$OOMOL_CONNECT_ENCRYPTION_KEY" \
  -e OOMOL_CONNECT_ADMIN_TOKEN="$OOMOL_CONNECT_ADMIN_TOKEN" \
  docker.io/REPLACE_WITH_DOCKERHUB_USERNAME/open-connector:latest
```

完整环境变量参考见 [configuration.md](configuration.md)，连接 provider 见 [credentials.md](credentials.md)。

### PostgreSQL Migration

使用 PostgreSQL 时，请在服务器首次启动前，以及启动包含待执行 migration 的新镜像版本前，显式运行镜像的
`migrate` 命令。Migration 应使用即将部署的同一个镜像标签：

```bash
OPEN_CONNECTOR_VERSION="<release-version>"

docker run --rm \
  -e OOMOL_CONNECT_DATABASE_URL="postgresql://migration_user:password@db.example.com:5432/open_connector?sslmode=verify-full" \
  "docker.io/REPLACE_WITH_DOCKERHUB_USERNAME/open-connector:${OPEN_CONNECTOR_VERSION}" \
  migrate
```

将 `<release-version>` 替换为实际部署的 release tag。Migration 镜像和服务器镜像必须使用同一个 tag。

该命令应用 migration 后便会退出，不会启动 HTTP 服务器。不给镜像传命令时仍然默认启动服务器；服务器只检查
schema 是否就绪，不会执行 PostgreSQL DDL。

### Docker Compose

仓库自带一个 [`docker-compose.yml`](../docker-compose.yml)，直接运行这个发布镜像。在仓库目录下，先 export
上面的 secret，再启动：

```bash
docker compose up
```

导出 `OOMOL_CONNECT_DATABASE_URL` 后，可以通过一次性 Compose 命令执行 PostgreSQL migration：

```bash
docker compose run --rm connector migrate
```

想改为从源码构建而不是拉取：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

## 验证

检查健康检查端点：

```bash
curl http://localhost:3000/health
```

预期响应为：

```json
{ "ok": true }
```

## 镜像如何发布

镜像会自动构建并推送，因此上面的标签始终保持最新：每次 push 到 `main` 会更新 `tip` 并新增 `<short-sha>`
标签，每次发布 release 会新增 `latest` 和 release 版本号。每个标签都是为 `linux/amd64` 和 `linux/arm64`
原生构建的多架构 manifest。构建定义见
[`.github/workflows/publish-docker.yml`](../.github/workflows/publish-docker.yml)，现已改为发布到 Docker Hub
而非 GHCR。

要在本 fork 上启用发布，需要在 GitHub 仓库中设置（Settings -> Secrets and variables -> Actions）：

- **变量** `DOCKERHUB_USERNAME` — 你的 Docker Hub 用户名或组织。这会成为镜像路径：
  `docker.io/<DOCKERHUB_USERNAME>/open-connector`。
- **Secret** `DOCKERHUB_TOKEN` — 一个具有 Read & Write 权限的 Docker Hub access token（Docker Hub ->
  Account Settings -> Security -> Personal access tokens -> Generate new token）。不要使用 Docker Hub
  账户密码。

如果这两项都没有设置，`Publish Docker Image` workflow 将无法登录 Docker Hub。
