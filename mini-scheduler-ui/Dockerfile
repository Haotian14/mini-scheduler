FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY mini-scheduler/master/package.json ./mini-scheduler/master/
COPY mini-scheduler/worker/package.json ./mini-scheduler/worker/
COPY mini-scheduler-ui/package.json ./mini-scheduler-ui/
RUN npm ci

COPY mini-scheduler-ui ./mini-scheduler-ui
ARG VITE_API_URL=http://127.0.0.1:3000
ARG VITE_SCHEDULER_TOKEN=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SCHEDULER_TOKEN=$VITE_SCHEDULER_TOKEN
RUN npm run build --workspace mini-scheduler-ui

FROM nginx:alpine AS serve
COPY --from=build /app/mini-scheduler-ui/dist /usr/share/nginx/html
EXPOSE 80
