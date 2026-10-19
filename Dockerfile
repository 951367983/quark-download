FROM node:22-alpine
WORKDIR /app
COPY quark-dl.js .
ENV PORT=8787 HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "quark-dl.js"]
