// Sample input presets per generator inputKind. Shared by the Plugins panel and
// the Generate modal so the starter content stays in one place.

export const SAMPLES: Record<string, string> = {
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
  htmlComposition: `<!doctype html>
<html>
<head><style>
  body{margin:0;background:#0e1230;color:#fff;font-family:Inter,sans-serif;
       display:flex;align-items:center;justify-content:center;height:100vh}
  h1{font-size:96px}
</style></head>
<body data-composition-duration="4">
  <h1 id="t">Hello HyperFrames</h1>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    gsap.from("#t",{opacity:0,y:60,duration:1.2,ease:"power3.out"});
  </script>
</body>
</html>`,
};
