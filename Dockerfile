FROM node:24-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app


FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build


FROM base AS production

ENV NODE_ENV=production
ENV PORT=3000
ENV SHUFFLE_DATABASE_PATH=/app/storage/solid-objects.sqlite3

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist
COPY public ./public
COPY src ./src

RUN mkdir -p /app/storage && chown -R node:node /app

USER node
EXPOSE 3000

CMD ["node", "dist/main.js"]
