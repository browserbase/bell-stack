import { operatorJwt, parseRsaPrivateKey, JWT_TTL_SECONDS } from "../server/crossmint/operator-jwt.ts";

// Prints a ten-minute operator JWT for Crossmint Agent Cards, signed with CROSSMINT_JWT_PRIVATE_KEY.
// Use it to sign in to a card setup app, or to call the order intent API by hand. Treat it like a
// password until it expires: it can create order intents and mint cards for the operator.
// Usage: pnpm crossmint:operator-jwt
const projectId = process.env.CROSSMINT_PROJECT_ID?.trim();
const userId = process.env.CROSSMINT_USER_ID?.trim();
const configured = process.env.CROSSMINT_JWT_PRIVATE_KEY?.trim();
if (!projectId || !userId || !configured) throw new Error("Set CROSSMINT_PROJECT_ID, CROSSMINT_USER_ID, and CROSSMINT_JWT_PRIVATE_KEY.");
const privateKey = parseRsaPrivateKey(configured);
if (!privateKey) throw new Error("CROSSMINT_JWT_PRIVATE_KEY must be a base64-encoded PEM RSA private key of at least 2048 bits.");

console.log(operatorJwt({ projectId, userId, privateKey }));
console.error(`Valid for ${JWT_TTL_SECONDS / 60} minutes.`);
