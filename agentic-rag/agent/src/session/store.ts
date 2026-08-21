import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

const ENDPOINT = process.env.FLOCI_ENDPOINT ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const TABLE = "agent_sessions";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: REGION,
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "floci", secretAccessKey: "floci" },
  }),
  { marshallOptions: { removeUndefinedValues: true } },
);

const rawDdb = new DynamoDBClient({
  region: REGION,
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "floci", secretAccessKey: "floci" },
});

export async function ensureTable(): Promise<void> {
  try {
    await rawDdb.send(new DescribeTableCommand({ TableName: TABLE }));
    return;
  } catch (e) {
    if (!(e instanceof ResourceNotFoundException)) throw e;
  }
  await rawDdb.send(
    new CreateTableCommand({
      TableName: TABLE,
      AttributeDefinitions: [{ AttributeName: "session_id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "session_id", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  await new Promise((r) => setTimeout(r, 1500));
}

export interface SessionRecord {
  session_id: string;
  created_at: string;
  last_query: string;
  last_response: string;
  iterations: number;
}

export async function saveSession(rec: SessionRecord): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: rec }));
}

export async function getSession(id: string): Promise<SessionRecord | null> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { session_id: id } }));
  return (r.Item as SessionRecord | undefined) ?? null;
}