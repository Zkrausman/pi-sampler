# Output optimizer — withdrawn

`@zkrausman/pi-output-optimizer` was withdrawn from GitHub Packages and will
receive no further releases. It is retained in this repository only as
historical source; do not publish it again.

Use [Pith](https://github.com/Zkrausman/Pith) as the sole output-optimization
engine instead:

```powershell
pith install --pi
```

Pith installs its Pi hook globally and transforms large successful shell output
before it reaches the model context. Do not install this package alongside Pith,
as two output transformers can process the same result.

## Existing consumers

Remove the package from Pi project settings:

```powershell
pi remove -l npm:@zkrausman/pi-output-optimizer
```

Then restart Pi after installing or updating Pith. Configure Pith through its
own project configuration; this package's `output-optimizer.json` settings no
longer apply.
