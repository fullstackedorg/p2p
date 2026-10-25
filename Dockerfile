FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production P2P_DATA_DIR=/data

COPY package.json ./
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4444

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD ["node", "src/server/healthcheck.ts"]

CMD ["node", "src/server/main.ts"]
