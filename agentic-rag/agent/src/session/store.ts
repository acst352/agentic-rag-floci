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
  // v1.3 H-03 (PRD §4, §13, SEC-03): subject del propietario de la
  // sesión. En el esquema DynamoDB actual es un atributo escalar; en
  // v2.0 lo promoveremos a parte de la clave compuesta (PK + SK) o
  // añadiremos un GSI por user_id si el listado por usuario se hace
  // necesario.
  user_id: string;
  created_at: string;
  last_query: string;
  last_response: string;
  iterations: number;
  metadata?: Record<string, unknown>;
}

export async function saveSession(rec: SessionRecord): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: rec }));
}

/**
 * v1.3 H-03 (PRD §4, §13, SEC-03): la lectura aplica el filtro de
 * autorización a nivel de recurso. Si el session_id no existe, o si
 * existe pero pertenece a otro user_id, devolvemos null para que la
 * ruta devuelva 404 indistinguible del caso "no existe" — así no
 * facilitamos la enumeración de session_id ajenos.
 *
 * userId vacío se considera "no autorizado" (devuelve null), nunca
 * "todos", para evitar un bypass accidental si el caller olvida
 * propagar el subject del hook HMAC.
 */
export async function getSession(
  id: string,
  userId: string,
): Promise<SessionRecord | null> {
  if (!userId) return null;
  const r = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { session_id: id } }),
  );
  const item = r.Item as SessionRecord | undefined;
  if (!item) return null;
  if (item.user_id !== userId) return null;
  return item;
}