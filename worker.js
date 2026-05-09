const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function checkOrders() {
  console.log("checking orders...");

  const { data: orders, error } = await supabase
    .from('orders')
    .select('*')
    .eq('status', 'pending');

  if (error) {
    console.log(error);
    return;
  }

  for (const order of orders) {
    console.log("new order:", order.id);

    // Имитация улучшения фото
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Имитация генерации видео
    await new Promise(resolve => setTimeout(resolve, 5000));

    const fakeVideoUrl =
      "https://samplelib.com/lib/preview/mp4/sample-5s.mp4";

    await supabase
      .from('orders')
      .update({
        status: 'done',
        result_video_url: fakeVideoUrl
      })
      .eq('id', order.id);

    console.log("done:", order.id);
  }
}

setInterval(checkOrders, 10000);

console.log("worker started");