console.log("Higgsfield worker started");

setInterval(() => {
  console.log("Worker is alive:", new Date().toISOString());
}, 30000);