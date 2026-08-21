FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile || yarn install
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN yarn build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json yarn.lock* ./
RUN yarn install --production --frozen-lockfile || yarn install --production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
EXPOSE 3002
CMD ["node", "dist/server.js"]