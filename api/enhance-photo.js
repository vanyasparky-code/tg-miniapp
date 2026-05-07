export default async function handler(req, res) {
  try {
    const response = await fetch("https://fal.run/fal-ai/nano-banana/edit", {
      method: "POST",
      headers: {
        "Authorization": `Key ${process.env.FAL_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt: "Use the provided reference photos to create a consistent, realistic character reference sheet of this exact person, combining the facial features, hairstyle, proportions, and overall appearance into one unified and accurate design. Show the person in four full-body turnaround views arranged horizontally: front view, left side view, right side view, back view. Each full-body character must be standing in a neutral A-pose, arms slightly extended downward in a relaxed natural position. Hands must be clearly visible in all views. The person must appear calm, confident, and neutral in all full-body views, with a natural closed-mouth expression. Below each full-body view, include a corresponding close-up of the person’s face from the same angle: front, left side, right side, back. In the close-up face views, preserve the same identity and facial structure consistently. Expression should remain natural and professional. The front close-up may have a subtle neutral expression, slightly more alive than the full-body view, but still appropriate for a person. Maintain consistent proportions, facial identity, hairstyle, lighting, and clothing details across all views. The result should look realistic, clean, and professional, suitable. Background must be pure studio white. No extra props. No text labels. No decorative elements.",
        image_url: req.body.imageUrl
      })
    });

    const data = await response.json();

    return res.status(200).json(data);

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "enhance failed"
    });
  }
}