FROM node:24-alpine
RUN corepack enable pnpm
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/worker build
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@workspace/worker", "start"]
