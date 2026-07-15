// Sample input presets per generator inputKind. Shared by the Plugins panel and
// the Generate modal so the starter content stays in one place.

export const SAMPLES: Record<string, string> = {
  // Plain narration script for the Voiceover (Kokoro) generator — one line per
  // idea; the CLI speaks it sentence-by-sentence with a short breath gap.
  text:
    "Welcome back. Today we're going to keep it short and clear.\n" +
    "Type your script here, and Kokoro will speak it in the voice you pick.\n" +
    "The finished audio track drops straight onto your timeline.",
  lessonJson: JSON.stringify(
    {
      title: "Sample — f-strings",
      scenes: [
        {
          type: "title",
          text: "Python f-strings",
          subtitle: "sixty seconds",
          narration: "Ever glued strings together with plus signs and hated it? There's a better way.",
        },
        {
          type: "code",
          language: "python",
          code: "name = 'Ada'\nprint(f'Hello, {name}!')",
          title: "main.py",
          typingSpeed: 18,
          narration: "Put an f before the quote, and braces become windows into your variables.",
        },
        { type: "terminal", output: "Hello, Ada!", typingSpeed: 40, narration: "And there's our greeting." },
      ],
    },
    null,
    2
  ),
  funkyScenes: JSON.stringify(
    {
      fps: 30,
      scenes: [
        {
          code: "def greet(name):\n    return f\"Hello, {name}!\"\n\nprint(greet('World'))",
          language: "python",
          template: "panel",
          output: "Hello, World!",
        },
      ],
    },
    null,
    2
  ),
  // HyperFrames composition — a div carrying data-composition-id + data-width/
  // height/duration is the current runtime contract (v0.7+). Renders at 1920×1080
  // (matches the default "landscape" resolution param).
  htmlComposition: `<!doctype html>
<html>
<head>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>
    html,body{margin:0;width:1920px;height:1080px;overflow:hidden;
      background:#0e1230;font-family:Inter,sans-serif}
    #main{position:relative;width:1920px;height:1080px;
      display:flex;align-items:center;justify-content:center}
    h1{color:#fff;font-size:120px;margin:0}
  </style>
</head>
<body>
  <div id="main" data-composition-id="main" data-width="1920" data-height="1080" data-duration="3">
    <h1 id="t">Hello HyperFrames</h1>
  </div>
  <script>
    gsap.from("#t",{opacity:0,y:80,duration:1.2,ease:"power3.out"});
  </script>
</body>
</html>`,
};
