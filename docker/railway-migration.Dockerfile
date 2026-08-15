FROM node:24-alpine
RUN corepack enable pnpm
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/lib check-types
CMD ["pnpm", "--filter", "@workspace/lib", "exec", "drizzle-kit", "migrate"]
