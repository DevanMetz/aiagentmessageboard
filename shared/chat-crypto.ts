import * as pgp from "openpgp";

export const CHAT_PROTOCOL = "amb-chat-openpgp-v1";
const pgpConfig = {
  v6Keys: true,
  aeadProtect: true,
  preferredSymmetricAlgorithm: pgp.enums.symmetric.aes256,
  preferredAEADAlgorithm: pgp.enums.aead.gcm,
  preferredCompressionAlgorithm: pgp.enums.compression.uncompressed,
};
export type ChatIdentity = { agent_id: string; public_key: string; fingerprint: string };
export type ChatBackup = ChatIdentity & { protocol: typeof CHAT_PROTOCOL; private_key: string };
export type Recipient = { agent_id: string; fingerprint: string };
export type ChatEnvelope = {
  conversation_id: string;
  sender_id: string;
  client_id: string;
  revision: number;
  recipients: Recipient[];
  ciphertext: string;
  signature: string;
};
export type UnlockedChatKey = { identity: ChatIdentity; privateKey: pgp.PrivateKey };

export function keyProofText(agentId: string, fingerprint: string) {
  return JSON.stringify([CHAT_PROTOCOL, "register", agentId, fingerprint]);
}
export function envelopeText(envelope: Omit<ChatEnvelope, "signature">) {
  return JSON.stringify([CHAT_PROTOCOL, "message", envelope.conversation_id, envelope.sender_id,
    envelope.client_id, envelope.revision,
    envelope.recipients.map(r => [r.agent_id, r.fingerprint]), envelope.ciphertext]);
}
export function recipientsFor(identities: ChatIdentity[]): Recipient[] {
  return identities.map(({ agent_id, fingerprint }) => ({ agent_id, fingerprint }))
    .sort((a, b) => a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0);
}
export async function readIdentity(identity: ChatIdentity) {
  if (typeof identity.public_key !== "string" || identity.public_key.length > 12000 ||
      !identity.public_key.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----") || identity.public_key.includes("PRIVATE KEY"))
    throw new Error("A public encryption key is required.");
  const key = await pgp.readKey({ armoredKey: identity.public_key });
  if (key.isPrivate() || key.getFingerprint() !== identity.fingerprint || key.subkeys.length !== 1 ||
      key.getAlgorithmInfo().curve !== "nistP256" || key.keyPacket.version !== 6)
    throw new Error("Unsupported or mismatched chat identity key.");
  await key.verifyPrimaryKey();
  await key.getEncryptionKey();
  await key.getSigningKey();
  return key;
}
export async function detachedSignature(text: string, privateKey: pgp.PrivateKey): Promise<string> {
  return pgp.sign({ message: await pgp.createMessage({ text }), signingKeys: privateKey, detached: true, format: "armored" });
}
export async function verifyDetached(text: string, signature: string, publicKey: pgp.PublicKey) {
  const result = await pgp.verify({
    message: await pgp.createMessage({ text }), signature: await pgp.readSignature({ armoredSignature: signature }),
    verificationKeys: publicKey, expectSigned: true,
  });
  if (result.signatures.length !== 1) throw new Error("Exactly one valid sender signature is required.");
  await result.signatures[0].verified;
}
export async function createChatKey(agentId: string, passphrase: string): Promise<ChatBackup> {
  if (passphrase.length < 12 || passphrase.length > 128) throw new Error("Use a passphrase of 12–128 characters.");
  const result = await pgp.generateKey({
    type: "ecc", curve: "nistP256", userIDs: [{ name: agentId }], passphrase, format: "armored", config: pgpConfig,
  });
  const key = await pgp.readKey({ armoredKey: result.publicKey });
  return { protocol: CHAT_PROTOCOL, agent_id: agentId, public_key: result.publicKey,
    fingerprint: key.getFingerprint(), private_key: result.privateKey };
}
export async function unlockChatKey(backup: ChatBackup, passphrase: string, agentId: string): Promise<UnlockedChatKey> {
  if (backup.protocol !== CHAT_PROTOCOL || backup.agent_id !== agentId ||
      typeof backup.private_key !== "string" || backup.private_key.length > 16000)
    throw new Error("This recovery file belongs to a different account or has an unsupported format.");
  await readIdentity(backup);
  const locked = await pgp.readPrivateKey({ armoredKey: backup.private_key });
  if (locked.isDecrypted()) throw new Error("The recovery file must contain a passphrase-protected private key.");
  if (locked.getFingerprint() !== backup.fingerprint) throw new Error("Recovery file keys do not match.");
  let privateKey;
  try { privateKey = await pgp.decryptKey({ privateKey: locked, passphrase }); }
  catch { throw new Error("Could not unlock your key. Check the passphrase and recovery file."); }
  const { agent_id, public_key, fingerprint } = backup;
  return { identity: { agent_id, public_key, fingerprint }, privateKey };
}
export async function registrationFor(key: UnlockedChatKey) {
  return { ...key.identity, proof: await detachedSignature(keyProofText(key.identity.agent_id, key.identity.fingerprint), key.privateKey) };
}

export function checkPinnedIdentities(identities: ChatIdentity[], pins: Record<string, string>) {
  const next = { ...pins };
  for (const identity of identities) {
    if (next[identity.agent_id] && next[identity.agent_id] !== identity.fingerprint)
      throw new Error("A participant's encryption key changed. Sending and reading are paused; verify their identity through another trusted channel.");
    next[identity.agent_id] = identity.fingerprint;
  }
  return next;
}

export async function encryptChatMessage(input: {
  conversationId: string; revision: number; content: string; identities: ChatIdentity[];
  sender: UnlockedChatKey; clientId?: string;
}): Promise<ChatEnvelope> {
  const { conversationId, revision, content, identities, sender } = input;
  if (!content.trim() || content.length > 5000) throw new Error("Messages must contain 1–5,000 characters.");
  const recipients = recipientsFor(identities);
  if (recipients.length < 2 || recipients.length > 10 || new Set(recipients.map(r => r.agent_id)).size !== recipients.length ||
      !recipients.some(r => r.agent_id === sender.identity.agent_id && r.fingerprint === sender.identity.fingerprint))
    throw new Error("The active participants must include your encryption key.");
  const encryptionKeys = await Promise.all(identities.map(readIdentity));
  const context = { protocol: CHAT_PROTOCOL, conversation_id: conversationId, sender_id: sender.identity.agent_id,
    client_id: input.clientId ?? crypto.randomUUID(), revision, recipients };
  const ciphertext = await pgp.encrypt({
    message: await pgp.createMessage({ text: JSON.stringify({ ...context, content }) }),
    encryptionKeys, signingKeys: sender.privateKey, format: "armored", config: pgpConfig,
  });
  const envelope = { ...context, ciphertext };
  return { ...envelope, signature: await detachedSignature(envelopeText(envelope), sender.privateKey) };
}

export async function decryptChatMessage(envelope: ChatEnvelope, sender: ChatIdentity, recipient: UnlockedChatKey): Promise<string> {
  if (envelope.sender_id !== sender.agent_id || !envelope.recipients.some(r =>
      r.agent_id === recipient.identity.agent_id && r.fingerprint === recipient.identity.fingerprint))
    throw new Error("Message identity or recipient mismatch.");
  const verificationKey = await readIdentity(sender);
  await verifyDetached(envelopeText(envelope), envelope.signature, verificationKey);
  const message = await pgp.readMessage({ armoredMessage: envelope.ciphertext });
  const decrypted = await pgp.decrypt({ message, decryptionKeys: recipient.privateKey,
    verificationKeys: verificationKey, expectSigned: true, format: "utf8", config: { maxDecompressedMessageSize: 32768 } });
  if (decrypted.signatures.length !== 1) throw new Error("The encrypted message is not signed by its sender.");
  await decrypted.signatures[0].verified;
  if (decrypted.data.length > 24000) throw new Error("Decrypted message is too large.");
  const value = JSON.parse(decrypted.data);
  if (value.protocol !== CHAT_PROTOCOL || value.conversation_id !== envelope.conversation_id ||
      value.sender_id !== envelope.sender_id || value.client_id !== envelope.client_id || value.revision !== envelope.revision ||
      JSON.stringify(value.recipients) !== JSON.stringify(envelope.recipients) ||
      typeof value.content !== "string" || !value.content.trim() || value.content.length > 5000)
    throw new Error("The signed message does not match this conversation.");
  return value.content;
}
