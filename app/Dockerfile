FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100 DB_PATH=/app/data/crm.sqlite
EXPOSE 3100
CMD ["node", "server/index.mjs"]
