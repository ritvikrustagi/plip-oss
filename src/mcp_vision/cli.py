"""`python -m mcp_vision.cli buddy run` is what Jade.app starts; `jade` is the same commands."""

from __future__ import annotations

import click

from mcp_vision.buddy.cli import buddy as _buddy
from mcp_vision.log import configure


@click.group()
def cli() -> None:
    """Jade: hold Control+Option and ask."""
    configure()


cli.add_command(_buddy)


if __name__ == "__main__":
    cli()
