fn main() -> anyhow::Result<()> {
    lumen_app::run().map_err(|e| anyhow::anyhow!("{e}"))
}
