use std::fmt::{Display, Formatter};

pub(super) trait FromParsingBuf: Sized {
    fn parse(buffer: &mut ParsingBuf) -> Result<Self, ParseRangeError>;
}

pub(super) struct ParsingBuf<'a> {
    pub(super) buf: &'a str,
}

impl<'a> ParsingBuf<'a> {
    pub fn new(source: &'a str) -> ParsingBuf {
        Self { buf: source }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn read(&mut self, ch: char) -> Result<(), ParseRangeError> {
        match self.buf.chars().next() {
            Some(c) if c == ch => {
                self.skip();
                Ok(())
            }
            Some(c) => Err(ParseRangeError::invalid_char(c)),
            None => Err(ParseRangeError::unexpected_end()),
        }
    }

    pub fn first(&self) -> Option<u8> {
        self.buf.as_bytes().first().copied()
    }

    pub fn first_char(&self) -> char {
        self.buf.chars().next().expect("invalid state")
    }

    pub fn skip(&mut self) -> &mut Self {
        if self.buf.len() != 0 {
            self.buf = &self.buf[1..];
        }
        self
    }

    pub fn get(&self, index: usize) -> Option<u8> {
        self.buf.as_bytes().get(index).copied()
    }

    pub fn skip_ws(&mut self) {
        self.buf = self.buf.trim_start();
    }

    pub fn take(&mut self, count: usize) -> &str {
        let (a, b) = self.buf.split_at(count);
        self.buf = b;
        a
    }
}

#[derive(Debug)]
pub struct ParseRangeError {
    inner: Inner,
}

impl Display for ParseRangeError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self.inner {
            Inner::VersionSegmentTooBig => f.write_str("version segment too big"),
            Inner::UnexpectedEnd => f.write_str("unexpected end"),
            Inner::InvalidChar(c) => write!(f, "invalid char: {:?}", c),
        }
    }
}

impl std::error::Error for ParseRangeError {}

#[derive(Debug)]
enum Inner {
    VersionSegmentTooBig,
    UnexpectedEnd,
    InvalidChar(char),
}

impl ParseRangeError {
    pub(super) fn too_big() -> Self {
        Self {
            inner: Inner::VersionSegmentTooBig,
        }
    }
    pub(super) fn invalid_char(c: char) -> Self {
        Self {
            inner: Inner::InvalidChar(c),
        }
    }
    pub(super) fn unexpected_end() -> ParseRangeError {
        Self {
            inner: Inner::UnexpectedEnd,
        }
    }
}
