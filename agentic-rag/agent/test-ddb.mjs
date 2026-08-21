import { DynamoDBClient, CreateTableCommand, DescribeTableCommand, ScanCommand, ResourceNotFoundException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = new DynamoDBClient({
  region: "us-east-1",
  endpoint: "http://localhost:4566",
  credentials: { accessKeyId: "floci", secretAccessKey: "floci" },
});
const doc = DynamoDBDocumentClient.from(ddb);

console.log("=== Describe agent_sessions ===");
try {
  const desc = await ddb.send(new DescribeTableCommand({ TableName: "agent_sessions" }));
  console.log("status:", desc.Table.TableStatus, "items:", desc.Table.ItemCount);
} catch (e) {
  if (e instanceof ResourceNotFoundException) {
    console.log("NOT found, creating...");
    await ddb.send(new CreateTableCommand({
      TableName: "agent_sessions",
      AttributeDefinitions: [{ AttributeName: "session_id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "session_id", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    }));
    console.log("Created. Waiting 2s...");
    await new Promise(r => setTimeout(r, 2000));
  } else throw e;
}

console.log("=== Insert test item ===");
await doc.send(new PutCommand({
  TableName: "agent_sessions",
  Item: { session_id: "test-direct", note: "from test-ddb.mjs" },
}));
console.log("Inserted test-direct");

console.log("=== Scan again ===");
const scan = await ddb.send(new ScanCommand({ TableName: "agent_sessions" }));
console.log("Items:", scan.Count);
for (const item of scan.Items ?? []) {
  console.log(JSON.stringify(item, null, 2));
}