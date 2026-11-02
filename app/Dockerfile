FROM node:24-alpine

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node app.js ./
COPY --chown=node:node src ./src

USER node

EXPOSE 3000

CMD ["node", "app.js"]