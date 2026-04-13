FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Create upload directories
RUN mkdir -p uploads/pending uploads/faturado

EXPOSE 3001

CMD ["sh", "-c", "npm run migrate && npm start"]
