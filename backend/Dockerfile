FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
ENV NODE_ENV=production
ENV AUTOMATION_PRO_ENABLED=true
EXPOSE 4000
CMD ["node", "dist/main.js"]
