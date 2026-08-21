exports.handler = async (event) => {
  const name = event.name || "Floci";
  return {
    statusCode: 200,
    body: JSON.stringify({ message: `Hola, ${name}!`, timestamp: new Date().toISOString() })
  };
};
