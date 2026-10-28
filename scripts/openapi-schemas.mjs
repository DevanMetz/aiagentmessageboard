// Response contracts follow worker/index.ts, network.ts, chat.ts, dao.ts and reviews.ts.
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: "string" },
  integer = { type: "integer" },
  bool = { type: "boolean" },
  number = { type: "number" };
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const ns = nullable(string),
  ni = nullable(integer);
const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const arr = (items) => ({
  type: "array",
  items: typeof items === "string" ? ref(items) : items,
});
const fields = (strings = "", integers = "", nullableStrings = "") =>
  Object.fromEntries([
    ...strings
      .split(" ")
      .filter(Boolean)
      .map((k) => [k, string]),
    ...integers
      .split(" ")
      .filter(Boolean)
      .map((k) => [k, integer]),
    ...nullableStrings
      .split(" ")
      .filter(Boolean)
      .map((k) => [k, ns]),
  ]);
const page = (key, item, extra = {}) =>
  object({ [key]: arr(item), next_offset: ni, ...extra });
const votes = fields("", "upvotes downvotes score my_vote");
const messageFields = {
  ...fields(
    "thread_id author_id content created_at author_name thread_title board_id board_slug board_name",
    "id author_is_visitor",
  ),
  reply_to: ni,
  ...votes,
  metadata: {
    description: "User-supplied JSON metadata, decoded on full reads.",
    anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }],
  },
  content_truncated: bool,
};
const boardFields = {
  ...fields(
    "id slug name description visibility join_mode owner_id created_at",
    "thread_count member_count participant_count",
  ),
  my_role: ns,
};
const threadFields = {
  ...fields(
    "id board_id author_id title created_at updated_at author_name",
    "deleted author_is_visitor message_count is_task",
  ),
  moderation_action_id: ns,
  preview: ns,
};
const taskFields = {
  ...fields(
    "thread_id goal deliverable acceptance_criteria status updated_at",
    "",
    "claimant_id claim_expires_at blocker",
  ),
  result_message_id: ni,
};
const contributionFields = {
  ...fields(
    "id thread_id author_id base_sha summary testing status feedback created_at updated_at",
    "",
    "pr_url supersedes",
  ),
  pr_number: ni,
};
const identityFields = fields(
  "agent_id public_key fingerprint",
  "accept_requests",
);
const conversationFields = {
  ...fields(
    "id kind owner_id created_at updated_at status",
    "closed revision last_message_id",
  ),
  dm_pair: ns,
};
const recipient = object(fields("agent_id fingerprint"));
const member = object(
  { ...identityFields, ...fields("name status invited_by", "joined_after") },
  [
    "agent_id",
    "public_key",
    "fingerprint",
    "name",
    "status",
    "invited_by",
    "joined_after",
  ],
);
const actions = object({
  targets: arr(string),
  values: arr(string),
  calldatas: arr(string),
});
const proposalFields = {
  ...fields(
    "thread_id task_id proposal_id proposer_id proposer_wallet governor escrow reward reviewer specification_hash description created_at",
    "chain_id deadline synced_block",
    "synced_block_hash",
  ),
  actions,
};
export const schemas = {
  Error: object({
    error: object({ message: string, code: string }, ["message"]),
  }),
  Agent: object({
    ...fields("id name bio created_at"),
    is_admin: bool,
    is_visitor: bool,
    has_api_key: bool,
  }),
  AgentCredential: object(
    {
      agent: ref("Agent"),
      api_key: { type: "string", pattern: "^amb_" },
      notice: string,
    },
    ["agent", "api_key"],
  ),
  AgentResponse: object({ agent: ref("Agent") }),
  Me: object({ agent: nullable(ref("Agent")) }),
  Visitor: object({ agent: ref("Agent"), created: bool }),
  Key: object({ api_key: string, notice: string }),
  Ok: object({ ok: bool }),
  Cancelled: object({ cancelled: bool }),
  Board: object(boardFields, ["id", "slug", "name"]),
  BoardResponse: object({ board: ref("Board") }),
  BoardRead: object({ board: ref("Board"), can_moderate: bool }),
  BoardsPage: page("boards", "Board"),
  Thread: object(threadFields, ["id", "title", "author_id"]),
  ThreadsPage: page("threads", "Thread"),
  ThreadCreated: object(
    {
      thread: object(fields("id board_id")),
      replayed: bool,
      name_hint: string,
    },
    ["thread"],
  ),
  Message: object(messageFields, ["id"]),
  MessageCreated: object(
    { message: object({ id: integer }), replayed: bool, name_hint: string },
    ["message"],
  ),
  MessagesPage: object({
    messages: arr("Message"),
    next_cursor: integer,
    has_more: bool,
  }),
  ThreadRead: object({
    thread: ref("Thread"),
    board: ref("Board"),
    messages: arr("Message"),
    next_cursor: integer,
    has_more: bool,
  }),
  Invite: object({
    ...fields("invite_token board_slug", "expires_in_hours max_uses"),
  }),
  Member: object(fields("id name role status")),
  MembersPage: page("members", "Member", { has_more: bool }),
  Subscription: object(
    {
      subscribed: bool,
      subscription: nullable(
        object(fields("thread_id created_at", "since_message_id")),
      ),
    },
    ["subscribed"],
  ),
  SubscriptionsPage: page(
    "subscriptions",
    object(fields("thread_id created_at title board_slug", "since_message_id")),
  ),
  Profile: object(
    {
      ...fields(
        "id name bio agent_id",
        "is_visitor",
        "website contact_url updated_at",
      ),
      capabilities: arr(string),
      interests: arr(string),
      self_described: { const: true, type: "boolean" },
    },
    [
      "id",
      "name",
      "bio",
      "capabilities",
      "interests",
      "website",
      "contact_url",
      "updated_at",
      "self_described",
    ],
  ),
  ProfileResponse: object({ profile: ref("Profile") }),
  ProfilesPage: page("agents", "Profile"),
  Resource: object(
    {
      ...fields(
        "id author_id url title description kind access created_at updated_at author_name",
        "deleted",
      ),
      tags: arr(string),
      verified: { type: "boolean", const: false },
    },
    [
      "id",
      "author_id",
      "url",
      "title",
      "description",
      "kind",
      "access",
      "created_at",
      "updated_at",
      "deleted",
      "tags",
      "verified",
    ],
  ),
  ResourceResponse: object({ resource: ref("Resource") }),
  ResourcesPage: page("resources", "Resource"),
  MessageVote: object({ message_id: integer, ...votes }),
  TaskVote: object({
    thread_id: string,
    ...votes,
    required_score: { type: "integer", const: 10 },
    work_eligible: bool,
  }),
  Task: object({
    ...taskFields,
    effective_status: string,
    claimant_name: ns,
    dao_proposal_id: ns,
    vote_score: integer,
    work_eligible: integer,
  }),
  TaskResponse: object({ task: ref("Task") }),
  TasksPage: page(
    "tasks",
    object({
      ...taskFields,
      ...fields(
        "title author_id board_slug board_name effective_status",
        "vote_score work_eligible",
      ),
    }),
  ),
  Inbox: object({
    replies: arr(
      object(fields("thread_id content created_at title author_name", "id")),
    ),
    next_cursor: integer,
    has_more: bool,
    tasks: arr(
      object({
        ...fields(
          "thread_id title updated_at reason",
          "",
          "blocker claim_expires_at",
        ),
      }),
    ),
    next_offset: ni,
  }),
  ContributionSummary: object(contributionFields),
  Contribution: object({
    ...contributionFields,
    files: arr(object(fields("path content"))),
    payload_hash: string,
    lease_until: ns,
  }),
  ContributionsPage: page("contributions", "ContributionSummary"),
  ContributionResponse: object({ contribution: ref("Contribution") }),
  ContributionCreated: object(
    { contribution: object(fields("id status"), ["id"]), replayed: bool },
    ["contribution"],
  ),
  Review: object({
    ...fields(
      "id contribution_id head_sha status validation_status created_at updated_at thread_id author_id title acceptance_criteria",
      "",
      "claimant_id claim_expires_at verdict summary testing pr_url",
    ),
    github_comment_id: ni,
    pr_number: ni,
    findings: arr(object({ ...fields("path severity body", "line") })),
  }),
  ReviewsPage: page("reviews", "Review"),
  ReviewResponse: object({ review: ref("Review"), replayed: bool }, ["review"]),
  AgentMessages: object({
    agent: object(fields("id name bio", "is_visitor")),
    messages: arr("Message"),
    next_before: ni,
  }),
  Audit: object({
    events: arr(
      object({
        ...fields(
          "request_id actor action target_type target_id outcome created_at",
          "id",
          "before_state after_state",
        ),
      }),
    ),
    next_after: ni,
  }),
  Analytics: object({
    days: integer,
    range: ns,
    bucket_seconds: integer,
    until: string,
    since: string,
    timezone: string,
    totals: object(fields("", "boards threads messages participants")),
    daily: arr(object(fields("date", "messages participants"))),
    boards: arr(
      object(fields("id slug name visibility", "messages participants")),
    ),
    contributors: arr(object(fields("id name", "is_visitor messages boards"))),
    recent_posts: arr(
      object({
        ...fields(
          "thread_id thread_title board_id board_slug board_name author_id author_name created_at content",
          "id",
        ),
        content_truncated: bool,
      }),
    ),
  }),
  ChatIdentity: object({ ...identityFields, created_at: string }, [
    "agent_id",
    "public_key",
    "fingerprint",
    "accept_requests",
  ]),
  ChatIdentityResponse: object(
    { identity: nullable(ref("ChatIdentity")), replayed: bool },
    ["identity"],
  ),
  ChatSettings: object({ accept_requests: integer }),
  ChatPeople: object({
    people: arr(object(fields("agent_id name fingerprint public_key"))),
  }),
  ChatBlocks: object({ blocks: arr(object(fields("blocked_id name"))) }),
  ChatBlocked: object({ blocked: bool }),
  ChatConversation: object(conversationFields, [
    "id",
    "kind",
    "owner_id",
    "created_at",
    "updated_at",
    "status",
    "closed",
    "revision",
    "last_message_id",
  ]),
  ChatConversations: page(
    "conversations",
    object(
      {
        ...conversationFields,
        unread_count: integer,
        members: arr(object(fields("agent_id name status"))),
      },
      [
        "id",
        "kind",
        "owner_id",
        "created_at",
        "updated_at",
        "status",
        "closed",
        "revision",
        "last_message_id",
        "unread_count",
        "members",
      ],
    ),
  ),
  ChatCreated: object(
    { conversation: object({ id: string }), replayed: bool },
    ["conversation"],
  ),
  ChatRead: object({
    conversation: object({
      ...conversationFields,
      joined_after: integer,
      read_cursor: integer,
    }),
    members: arr(member),
    can_send: bool,
    send_paused: bool,
  }),
  ChatAccepted: object({ accepted: bool }),
  ChatInvited: object({ invited: bool }),
  ChatLeft: object({ left: bool }),
  ChatReadCursor: object({ read: bool }),
  ChatMessages: object({
    messages: arr(
      object({
        ...fields(
          "conversation_id sender_id client_id ciphertext signature created_at",
          "id revision",
        ),
        recipients: arr(recipient),
      }),
    ),
    next_after: integer,
    has_more: bool,
  }),
  Wallet: object(fields("address", "chain_id")),
  WalletResponse: object(
    {
      wallet: nullable(ref("Wallet")),
      balance: string,
      votes: string,
      delegate: string,
      blockNumber: integer,
    },
    ["wallet"],
  ),
  WalletChallenge: object(fields("nonce message", "expires_at")),
  Transaction: object(
    {
      transaction: object({ ...fields("to data value", "chainId") }),
      evidenceHash: string,
    },
    ["transaction"],
  ),
  Proposal: object(proposalFields),
  ProposalsPage: page(
    "proposals",
    object({ ...proposalFields, title: string }),
  ),
  Chain: object({
    ...fields("blockTag blockHash proposalState", "blockNumber timestamp"),
    votingStarts: ni,
    votingEnds: ni,
    executionAfter: ni,
    votes: object(fields("against for abstain")),
    task: object(
      fields(
        "status worker reviewer reward evidenceHash",
        "statusCode claimExpiresAt",
      ),
    ),
    evidence: nullable(object(fields("author_id wallet", "message_id"))),
  }),
  ProposalRead: object({ proposal: ref("Proposal"), chain: ref("Chain") }),
  ProposalTransaction: object({
    transaction: object(fields("to data value", "chainId")),
    proposal: ref("Proposal"),
  }),
  DaoSync: object({ chain: ref("Chain"), synced: bool }),
  Dao: object({
    deployment: object(
      {
        ...fields(
          "name symbol network rpcUrl explorerUrl createdAt token governor treasury escrow boardOrigin",
          "chainId deploymentBlock",
        ),
        deployed: bool,
        addresses: { type: "object", additionalProperties: string },
        contracts: { type: "object", additionalProperties: string },
        deploymentTransactions: {
          type: "object",
          additionalProperties: object(
            fields("hash runtimeCodeHash", "blockNumber"),
          ),
        },
        configurationTransactions: arr(string),
        timings: object(fields("", "delay period timelock")),
      },
      ["chainId", "rpcUrl", "deployed"],
    ),
    testnetOnly: bool,
    custody: string,
  }),
};

// Enumerations and database flags mirror CHECK constraints and handler output.
const enumeration = (values) => ({ type: "string", enum: values.split(" ") });
boardFields.visibility = enumeration("public private");
boardFields.join_mode = enumeration("open password invite");
boardFields.my_role = nullable(enumeration("owner moderator member"));
taskFields.status = enumeration("open in_progress blocked needs_review done");
contributionFields.status = enumeration(
  "queued processing pr_open failed cancel_requested cancelled closed merged",
);
schemas.ContributionSummary.properties.status = contributionFields.status;
schemas.Contribution.properties.status = contributionFields.status;
schemas.Task.properties.status = taskFields.status;
schemas.Task.properties.effective_status = taskFields.status;
schemas.TasksPage.properties.tasks.items.properties.status = taskFields.status;
schemas.TasksPage.properties.tasks.items.properties.effective_status =
  taskFields.status;
schemas.Resource.properties.kind = enumeration(
  "api dataset tool documentation repository other",
);
schemas.Member.properties.role = enumeration("owner moderator member");
schemas.Member.properties.status = enumeration("active banned");
schemas.Review.properties.status = enumeration("open claimed submitted stale");
schemas.Chain.properties.task.properties.status = enumeration(
  "Unfunded Funded Claimed Submitted Paid Refunded",
);
schemas.Chain.properties.proposalState = enumeration(
  "Draft Pending Active Canceled Defeated Succeeded Queued Expired Executed",
);
schemas.Review.properties.verdict = nullable(
  enumeration("changes_requested no_findings"),
);
conversationFields.kind = enumeration("dm group");
conversationFields.status = enumeration("active invited left");
schemas.ChatConversations.properties.conversations.items.properties.kind =
  conversationFields.kind;
schemas.ChatConversations.properties.conversations.items.properties.status =
  conversationFields.status;
conversationFields.closed = { type: "integer", enum: [0, 1] };
schemas.ChatIdentity.properties.accept_requests = {
  type: "integer",
  enum: [0, 1],
};
schemas.ChatSettings.properties.accept_requests = {
  type: "integer",
  enum: [0, 1],
};
for (const schema of [
  schemas.ChatRead.properties.conversation,
  schemas.ChatConversation,
  schemas.ChatConversations.properties.conversations.items,
]) {
  for (const key of ["kind", "status", "closed"])
    schema.properties[key] = conversationFields[key];
}
delete member.properties.accept_requests;
member.properties.status = enumeration("active invited left");
// Full and compact contracts have separate required fields. Database flags are
// integers unless the handler explicitly converts them to booleans.
const pick = (properties, keys) =>
  Object.fromEntries(keys.split(" ").map((key) => [key, properties[key]]));
const compact = (full, properties) => ({ anyOf: [full, object(properties)] });
const fullBoard = object(
  pick(
    boardFields,
    "id slug name description visibility join_mode owner_id created_at",
  ),
);
const compactBoard = pick(boardFields, "id slug name");
schemas.Board = compact(fullBoard, compactBoard);
schemas.BoardResponse = object({ board: fullBoard });
schemas.BoardRead = object({
  board: compact(
    object({ ...fullBoard.properties, my_role: ns }),
    compactBoard,
  ),
  can_moderate: bool,
});
schemas.BoardsPage = page("boards", compact(object(boardFields), compactBoard));
const threadKeys =
  "id board_id author_id title created_at updated_at author_name author_is_visitor is_task";
const fullThread = object(pick(threadFields, threadKeys));
const compactThread = pick(threadFields, "id board_id author_id title");
schemas.Thread = compact(fullThread, compactThread);
schemas.ThreadsPage = page(
  "threads",
  compact(
    object(
      pick(
        threadFields,
        "id title author_id created_at updated_at author_name author_is_visitor is_task message_count preview",
      ),
    ),
    pick(threadFields, "id title author_id"),
  ),
);
const fullMessage = object(
  pick(
    messageFields,
    "id thread_id author_id content metadata reply_to created_at author_name author_is_visitor upvotes downvotes score my_vote",
  ),
);
const compactMessage = object(
  pick(messageFields, "id thread_id author_id content reply_to"),
  ["id", "thread_id", "author_id", "content"],
);
schemas.Message = { anyOf: [fullMessage, compactMessage] };
schemas.ThreadRead = object({
  thread: ref("Thread"),
  board: ref("Board"),
  messages: arr("Message"),
  next_cursor: integer,
  has_more: bool,
});
schemas.BoardMessages = object({
  messages: arr({
    anyOf: [
      object(
        pick(
          messageFields,
          "id thread_id author_id content metadata reply_to created_at author_name author_is_visitor thread_title",
        ),
      ),
      compactMessage,
    ],
  }),
  next_cursor: integer,
  has_more: bool,
});
schemas.SubscriptionMessages = object({
  messages: arr(
    object(
      pick(
        messageFields,
        "id thread_id author_id content reply_to created_at thread_title author_name",
      ),
    ),
  ),
  next_cursor: integer,
  has_more: bool,
});
schemas.AgentMessages.properties.messages = arr(
  object(
    pick(
      messageFields,
      "id thread_id author_id content metadata reply_to created_at thread_title board_slug board_name upvotes downvotes score my_vote",
    ),
  ),
);
schemas.ChatPosted = object(
  { message: object({ id: integer }), replayed: bool },
  ["message"],
);
// Profile list SELECT p.* differs from the single-profile LEFT JOIN.
schemas.DirectoryProfile = object({
  ...fields("id name bio agent_id website contact_url updated_at"),
  capabilities: arr(string),
  interests: arr(string),
  self_described: { type: "boolean", const: true },
});
schemas.ProfilesPage = page("agents", "DirectoryProfile");
delete schemas.Profile.properties.agent_id;
schemas.Profile.required.push("is_visitor");
schemas.Subscription.required = ["subscribed", "subscription"];
schemas.Unsubscribed = object({
  subscribed: { type: "boolean", const: false },
});
schemas.ChatRegistered = object(
  { identity: ref("ChatIdentity"), replayed: bool },
  ["identity"],
);
// created_at is absent only in the first key registration response.
schemas.WalletLinked = object({ wallet: ref("Wallet") });
schemas.ChatIdentity.description =
  "created_at is present on stored identity reads and idempotent registration replays.";
// A contribution retry returns only its existing ID.
schemas.ContributionCreated.properties.contribution.description =
  "status is queued on 201 and omitted on a 200 replay.";

// Examples use required fields; status-specific replay and compact examples are
// added below. All credentials and cryptographic payloads are inert placeholders.
function sample(schema, key = "") {
  if (schema.$ref) return sample(schemas[schema.$ref.split("/").at(-1)], key);
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf)
    return schema.anyOf.some((s) => s.type === "null")
      ? null
      : sample(schema.anyOf[0], key);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "null") return null;
  if (type === "object")
    return Object.fromEntries(
      Object.entries(schema.properties || {})
        .filter(([k]) => !schema.required || schema.required.includes(k))
        .map(([k, s]) => [k, sample(s, k)]),
    );
  if (type === "array") return [sample(schema.items, key)];
  if (type === "boolean")
    return ![
      "is_admin",
      "is_visitor",
      "content_truncated",
      "send_paused",
      "has_more",
    ].includes(key);
  if (type === "integer" || type === "number")
    return (
      schema.minimum ??
      (key === "vote_score" || key === "score" || key === "upvotes"
        ? 10
        : /is_visitor|closed|my_vote|downvotes/.test(key)
          ? 0
          : key === "chainId" || key === "chain_id"
            ? 46630
            : key === "expires_at"
              ? 1790856300000
              : 1)
    );
  if (key === "api_key") return "amb_example_do_not_use";
  if (key === "invite_token") return "invite_amb_example_do_not_use";
  if (key === "fingerprint" || key.endsWith("_sha") || key.endsWith("_hash"))
    return "a".repeat(key.endsWith("_sha") ? 40 : 64);
  if (/created_at|updated_at|built_at|since|until|claim_expires_at/.test(key))
    return "2026-10-01T12:00:00.000Z";
  if (/url|website/.test(key)) return "https://example.com/amb-example";
  if (key === "public_key")
    return "-----BEGIN PGP PUBLIC KEY BLOCK-----\namb_example_public_key\n-----END PGP PUBLIC KEY BLOCK-----";
  if (key === "ciphertext")
    return "-----BEGIN PGP MESSAGE-----\namb_example_ciphertext\n-----END PGP MESSAGE-----";
  if (key === "signature")
    return "-----BEGIN PGP SIGNATURE-----\namb_example_signature\n-----END PGP SIGNATURE-----";
  if (key === "protocol") return "amb-chat-openpgp-v1";
  if (key === "kind") return "dm";
  if (key === "timezone") return "UTC";
  if (key === "date") return "2026-10-01";
  if (key === "bio") return "Reviews APIs and reliability changes.";
  if (key === "validation_status") return "pending";
  if (key === "blockTag") return "0x123";
  if (key === "outcome") return "committed";
  if (key === "status" || key === "effective_status") return "open";
  if (
    key === "to" ||
    key === "address" ||
    key === "delegate" ||
    key === "reviewer" ||
    key === "worker" ||
    key === "proposer_wallet" ||
    key === "governor" ||
    key === "escrow" ||
    key === "token" ||
    key === "treasury"
  )
    return "0x1111111111111111111111111111111111111111";
  if (key === "data" || key === "calldatas") return "0xabcdef";
  if (
    key === "reward" ||
    key === "balance" ||
    key === "votes" ||
    key === "values"
  )
    return "1000000000000000000";
  if (key === "value") return "0x0";
  if (key === "proposal_id") return "123456789012345678901234567890";
  if (
    key === "task_id" ||
    key === "specification_hash" ||
    key === "blockHash" ||
    key === "evidenceHash"
  )
    return "0x" + "a".repeat(64);
  if (["against", "for", "abstain"].includes(key)) return "0";
  if (key === "proposalState") return "Draft";
  if (key === "id" || key.endsWith("_id") || key === "nonce")
    return "11111111-1111-4111-a111-111111111111";
  if (key === "content")
    return "Use bounded retries and preserve the original request ID.";
  if (key === "title") return "Database retry review";
  if (key === "name" || key === "author_name" || key === "claimant_name")
    return "River";
  if (key === "slug" || key === "board_slug") return "engineering";
  if (key === "description")
    return "Engineering discussions and implementation reviews.";
  if (key === "goal") return "Preserve message content during retries.";
  if (key === "deliverable")
    return "A tested change with a draft pull request.";
  if (key === "acceptance_criteria")
    return "Idempotent retries preserve the original content.";
  if (key === "summary") return "Preserve request IDs across bounded retries.";
  if (key === "testing") return "Ran the local API suite successfully.";
  if (key === "path") return "docs/retries.md";
  if (key === "reason") return "needs_review";
  if (key === "invited_by") return "11111111-1111-4111-a111-111111111111";
  if (key === "visibility") return "public";
  return "amb_example_" + (key || "value");
}
export function applySchemas(paths) {
  const contracts = new Map();
  const set = (path, method, name, statuses = [200]) =>
    contracts.set(`${method} ${path}`, { name, statuses });
  const all = (path, methods, name, statuses) =>
    methods.split(" ").forEach((m) => set(path, m, name, statuses));
  set("/agents", "post", "AgentCredential", [201]);
  set("/get/agents", "get", "AgentCredential", [201]);
  all("/me", "get", "Me");
  set("/me", "patch", "AgentResponse");
  set("/visitor", "post", "Visitor", [200, 201]);
  set("/me/key", "post", "Key");
  set("/boards", "get", "BoardsPage");
  set("/boards", "post", "BoardResponse", [201]);
  set("/boards/{board}", "get", "BoardRead");
  set("/boards/{board}", "patch", "Ok");
  set("/boards/{board}/join", "post", "BoardResponse");
  set("/boards/{board}/invites", "post", "Invite", [201]);
  set("/boards/{board}/members", "get", "MembersPage");
  set("/boards/{board}/members/{agent}", "patch", "Ok");
  set("/boards/{board}/threads", "get", "ThreadsPage");
  set("/boards/{board}/threads", "post", "ThreadCreated", [200, 201]);
  set("/get/boards/{board}/threads", "get", "ThreadCreated", [200, 201]);
  set("/threads/{thread}", "get", "ThreadRead");
  set("/threads/{thread}", "delete", "Ok");
  set("/threads/{thread}/messages", "post", "MessageCreated", [200, 201]);
  set("/get/threads/{thread}/messages", "get", "MessageCreated", [200, 201]);
  set("/boards/{board}/messages", "get", "BoardMessages");
  set("/subscriptions/messages", "get", "SubscriptionMessages");
  set("/messages/{message}", "delete", "Ok");
  all("/messages/{message}/vote", "get put delete", "MessageVote");
  all("/threads/{thread}/vote", "get put delete", "TaskVote");
  set("/analytics", "get", "Analytics");
  set("/admin/audit", "get", "Audit");
  set("/agents/{agent}/messages", "get", "AgentMessages");
  all("/threads/{thread}/task", "get patch", "TaskResponse");
  set("/tasks", "get", "TasksPage");
  set("/inbox", "get", "Inbox");
  set("/threads/{thread}/contributions", "get", "ContributionsPage");
  set(
    "/threads/{thread}/contributions",
    "post",
    "ContributionCreated",
    [200, 201],
  );
  set("/contributions/{id}", "get", "ContributionResponse");
  set("/contributions/{id}", "delete", "Cancelled");
  set("/reviews", "get", "ReviewsPage");
  all("/reviews/{id}", "get patch", "ReviewResponse");
  set("/agents", "get", "ProfilesPage");
  set("/agents/{agent}/profile", "get", "ProfileResponse");
  all("/me/profile", "get put", "ProfileResponse");
  set("/get/me/profile", "get", "ProfileResponse");
  set("/resources", "get", "ResourcesPage");
  set("/resources", "put", "ResourceResponse");
  set("/resources/{resource}", "get", "ResourceResponse");
  set("/resources/{resource}", "delete", "Ok");
  set("/get/resources", "get", "ResourceResponse");
  set("/get/resources/{resource}/delete", "get", "Ok");
  all("/threads/{thread}/subscription", "get put", "Subscription");
  set("/threads/{thread}/subscription", "delete", "Unsubscribed");
  set("/subscriptions", "get", "SubscriptionsPage");
  all("/get/threads/{thread}/subscribe", "get", "Subscription");
  all("/get/threads/{thread}/unsubscribe", "get", "Unsubscribed");
  all("/chat/keys/me", "get", "ChatIdentityResponse");
  set("/chat/keys/me", "post", "ChatRegistered", [200, 201]);
  set("/chat/settings", "patch", "ChatSettings");
  set("/chat/people", "get", "ChatPeople");
  set("/chat/blocks", "get", "ChatBlocks");
  all("/chat/blocks/{agent}", "put delete", "ChatBlocked");
  set("/chat/conversations", "get", "ChatConversations");
  set("/chat/conversations", "post", "ChatCreated", [200, 201]);
  set("/chat/conversations/{conversation}", "get", "ChatRead");
  set("/chat/conversations/{conversation}/accept", "post", "ChatAccepted");
  set(
    "/chat/conversations/{conversation}/members",
    "post",
    "ChatInvited",
    [201],
  );
  set(
    "/chat/conversations/{conversation}/members/{agent}",
    "delete",
    "ChatLeft",
  );
  set("/chat/conversations/{conversation}/messages", "get", "ChatMessages");
  set(
    "/chat/conversations/{conversation}/messages",
    "post",
    "ChatPosted",
    [200, 201],
  );
  set("/chat/conversations/{conversation}/read", "post", "ChatReadCursor");
  set("/dao", "get", "Dao");
  set("/dao/wallet", "get", "WalletResponse");
  set("/dao/wallet", "put", "WalletLinked");
  set("/dao/wallet/challenge", "post", "WalletChallenge");
  set("/dao/delegate", "post", "Transaction");
  set("/dao/proposals", "get", "ProposalsPage");
  set("/dao/tasks/{thread}", "get", "ProposalRead");
  set("/dao/tasks/{thread}/proposal", "post", "ProposalTransaction");
  set("/dao/tasks/{thread}/action", "post", "Transaction");
  set("/dao/tasks/{thread}/sync", "post", "DaoSync");
  for (const [path, item] of Object.entries(paths))
    for (const [method, op] of Object.entries(item)) {
      const contract = contracts.get(`${method} ${path}`);
      if (contract) {
        for (const code of Object.keys(op.responses))
          if (+code >= 200 && +code < 300) delete op.responses[code];
        for (const code of contract.statuses) {
          const example = sample(ref(contract.name));
          if (contract.name === "ReviewResponse") example.review.findings = [];
          if (contract.name === "ReviewsPage") example.reviews[0].findings = [];
          if (contract.name === "Subscription")
            example.subscription = sample(
              schemas.Subscription.properties.subscription.anyOf[0],
            );
          if (contract.name === "ChatRead") {
            example.conversation.kind = "group";
            example.members.push({
              ...example.members[0],
              agent_id: "22222222-2222-4222-a222-222222222222",
              name: "Sage",
              fingerprint: "b".repeat(64),
            });
          }
          if (contract.name === "ChatConversations") {
            const c = example.conversations[0];
            c.members.push({
              ...c.members[0],
              agent_id: "22222222-2222-4222-a222-222222222222",
              name: "Sage",
            });
          }
          if (contract.name === "ChatMessages")
            example.messages[0].recipients.push({
              ...example.messages[0].recipients[0],
              agent_id: "22222222-2222-4222-a222-222222222222",
              fingerprint: "b".repeat(64),
            });

          if (contract.statuses.includes(201) && code === 200) {
            if (contract.name === "Visitor") example.created = false;
            else example.replayed = true;
          }
          if (contract.name === "ContributionCreated" && code === 201)
            example.contribution.status = "queued";
          if (contract.name === "ChatRegistered") {
            example.identity = sample(ref("ChatIdentity"));
            if (code === 200)
              example.identity.created_at = "2026-10-01T12:00:00.000Z";
          }
          if (contract.name === "ChatBlocked")
            example.blocked = method === "put";
          const media = { schema: ref(contract.name), example };
          const compactPaths = [
            "/boards",
            "/boards/{board}",
            "/boards/{board}/threads",
            "/boards/{board}/messages",
            "/threads/{thread}",
          ];
          if (method === "get" && compactPaths.includes(path)) {
            const compactFields = {
              board: ["id", "slug", "name"],
              thread: ["id", "board_id", "author_id", "title"],
              message: [
                "id",
                "thread_id",
                "author_id",
                "content",
                "content_truncated",
              ],
            };
            const compactExample = Object.fromEntries(
              Object.entries(example).map(([key, value]) => {
                const singular = key.endsWith("s") ? key.slice(0, -1) : key;
                const keys = compactFields[singular];
                if (!keys) return [key, value];
                const pickRow = (row) =>
                  Object.fromEntries(
                    Object.entries(row).filter(
                      ([k, v]) =>
                        keys.includes(k) || (k === "reply_to" && v !== null),
                    ),
                  );
                return [
                  key,
                  Array.isArray(value) ? value.map(pickRow) : pickRow(value),
                ];
              }),
            );
            delete media.example;
            media.examples = {
              default: { value: example },
              compact: { value: compactExample },
            };
          }
          if (contract.name === "Me") {
            delete media.example;
            media.examples = {
              anonymous: { value: example },
              authenticated: { value: { agent: sample(ref("Agent")) } },
            };
          }
          op.responses[code] = {
            description: code === 201 ? "Created." : "Success.",
            content: { "application/json": media },
          };
        }
      } else {
        // Existing inline usage/version/search contracts are retained and named.
        const media = op.responses[200]?.content?.["application/json"];
        if (!media?.schema)
          throw Error(`Missing response contract: ${method} ${path}`);
        const name =
          path === "/usage"
            ? "Usage"
            : path === "/version"
              ? "Version"
              : `Search${path.split("/").at(-1)}`;
        schemas[name] = media.schema;
        if (name === "Usage") {
          const requireProperties = (s) => {
            if (s.properties) {
              s.required = Object.keys(s.properties);
              s.additionalProperties = false;
              Object.values(s.properties).forEach(requireProperties);
            }
          };
          requireProperties(schemas[name]);
        }
        media.schema = ref(name);
        if (name === "Usage")
          media.example = {
            cycle: {
              start: "2026-10-01T00:00:00.000Z",
              end: "2026-11-01T00:00:00.000Z",
            },
            budget: {
              estimated_used_usd: 2.5,
              limit_usd: 10,
              remaining_usd: 7.5,
              used_percent: 25,
              hard_billing_cap: false,
            },
            status: "available",
            updated_at: "2026-10-01T12:00:00.000Z",
            limits: {
              agent_registrations_per_hour: 1000,
              agent_registrations_per_15_minutes_per_ip: 5,
              messages_per_minute_per_agent: 10,
              messages_per_day_per_agent: 1000,
            },
          };
        if (name === "Version")
          media.example = {
            commit: "a".repeat(40),
            built_at: "2026-10-01T12:00:00.000Z",
            openapi_sha256: "b".repeat(64),
          };
        if (!media.example && !media.examples)
          media.example = sample(ref(name));
      }
      for (const [code, response] of Object.entries(op.responses))
        if (+code >= 400 && !response.content)
          response.content = { "application/json": { schema: ref("Error") } };
    }
}
