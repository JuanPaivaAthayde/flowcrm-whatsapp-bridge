FROM node:20-slim

RUN apt-get update && apt-get install -y git python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

ENV DATA_DIR=/data

EXPOSE 3001

CMD ["node", "index.js"]
