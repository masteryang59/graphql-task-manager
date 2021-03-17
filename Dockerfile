FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
# mongodb-memory-server is a dev dependency; never download mongod in the image.
ENV MONGOMS_DISABLE_POSTINSTALL=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts/seed.js ./scripts/seed.js

USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "src/index.js"]
ENV ROLLBACK_CHANGES=true
ENV TRACE_REQUEST=true
ENV ROLLBACK_CHANGES=true