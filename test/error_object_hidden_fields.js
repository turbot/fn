const logEntries = [];

try {
  const x = 2;
  const y = x + z;
} catch (ex) {
  console.log("Error is", ex);
  console.log("logEntries #1", logEntries);
  logEntries.push({ error: ex });
  console.log("logEntries #2", logEntries);
  console.log("logEntries JSON stringify", JSON.stringify(logEntries));
}
