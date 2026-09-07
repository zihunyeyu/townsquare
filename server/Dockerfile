FROM node:20-alpine

# 国内网络构建时可传 --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm ci --omit=dev --no-audit --no-fund

COPY src ./src

EXPOSE 8081 8082 8083
CMD ["node", "src/index.js"]
