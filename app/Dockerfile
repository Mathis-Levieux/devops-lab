FROM node:24-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY app.js ./
COPY src ./src

EXPOSE 3000
CMD ["node", "app.js"]
