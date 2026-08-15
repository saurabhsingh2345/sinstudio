package schema

/*
Carrying old documents across the change to what FitAuto means.

FitAuto used to fill on any clip the camera was working, and every screen
recording carries cursor effects, so most recorded clips were being cropped to
the canvas. Now FitAuto letterboxes. Left alone, that would silently un-crop
every project anyone has already made — a picture that has been the right shape
for weeks would suddenly acquire bars, which is exactly the kind of change that
makes a tool feel unreliable even when the new behaviour is better.

So the old rule is evaluated once and written down. A clip that WAS being filled
gets `fill` spelled out; everything else is left at FitAuto, which now means what
it says. After this the document expresses its own framing and no reader has to
know what the default used to be.

It has to be a ONE-TIME upgrade, and the stamp is what makes it one. Without it
this is not a migration at all but the old rule re-applied on every read: a clip
created after the change, letterboxed on purpose, would be converted to `fill`
the first time anyone added a zoom to it — silently cropping the picture, which
is precisely the behaviour being removed. The first version of this had that bug
and a test caught it by finding no letterbox where it had put one.

So: documents written before the change carry no stamp and are brought forward
once; everything saved since carries the stamp and is left alone forever. The
store stamps on write rather than trusting a client to send it back.
*/

// FitSchemaRev is the document revision at which FitAuto started meaning
// letterbox. A document at or above it has already been brought forward.
const FitSchemaRev = 1

// MigrateFit writes the fit that FitAuto used to imply, so a document renders
// after the change exactly as it did before it. A no-op on anything already
// stamped.
func MigrateFit(doc *EditDoc) {
	if doc == nil || doc.SchemaRev >= FitSchemaRev {
		return
	}
	doc.SchemaRev = FitSchemaRev
	for ti := range doc.Tracks {
		for ci := range doc.Tracks[ti].Clips {
			c := &doc.Tracks[ti].Clips[ci]
			if c.Fit != FitAuto {
				continue
			}
			// Titles and callouts are drawn at canvas size; they were never
			// fitted to anything and must not acquire a fit now.
			if c.Title != nil || c.Annotation != nil || c.AssetID == "" {
				continue
			}
			// The old rule, verbatim: cursor effects or zoom keyframes meant
			// the camera was working the clip, and a worked clip filled.
			if c.Cursor != nil || hasZoomKeyframes(c.Keyframes) {
				c.Fit = FitCover
			}
		}
	}
}

// hasZoomKeyframes mirrors render.clipHasZoomKeyframes EXACTLY: a scale keyed
// past 1.02, and nothing else.
//
// Not "any keyed scale, x or y", which is the rule it looks like it should be.
// A migration written from a memory of the old behaviour rather than from the
// old behaviour changes the documents it exists to leave alone — here it would
// have filled every clip carrying a hand-made pan, which the renderer was
// letterboxing.
func hasZoomKeyframes(kf map[string][]Keyframe) bool {
	for _, k := range kf["scale"] {
		if k.Value > 1.02 {
			return true
		}
	}
	return false
}
