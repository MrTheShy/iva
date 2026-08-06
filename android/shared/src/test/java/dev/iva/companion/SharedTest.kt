package dev.iva.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The parts of the apps that can be wrong without a device: where the request goes,
 * what each status code means out loud, and how a long answer is cut for the speech
 * engine. Everything else is Android APIs doing their own job.
 */
class ConfigTest {

    @Test
    fun `a trailing slash in the typed address does not double up`() {
        assertEquals(
            "https://iva.example.com/eve/v1/app",
            Config("https://iva.example.com/", "t").endpoint,
        )
        assertEquals(
            "https://iva.example.com/eve/v1/app",
            Config("https://iva.example.com", "t").endpoint,
        )
    }

    @Test
    fun `half-filled settings are not usable`() {
        assertFalse(Config("", "token").isComplete)
        assertFalse(Config("https://iva.example.com", "").isComplete)
        assertFalse(Config("   ", "  ").isComplete)
        assertTrue(Config("https://iva.example.com", "token").isComplete)
    }
}

class ReadAnswerTest {

    @Test
    fun `a reply is spoken as it came`() {
        val answer = IvaClient.readAnswer(200, """{"reply":"Fatto, promemoria per domani."}""")
        assertEquals(Answer.Spoken("Fatto, promemoria per domani."), answer)
    }

    @Test
    fun `an empty or unreadable body never becomes a silent success`() {
        for (body in listOf("""{"reply":""}""", "{}", "not json", "")) {
            assertTrue("body: $body", IvaClient.readAnswer(200, body) is Answer.Problem)
        }
    }

    @Test
    fun `a proxy that gives up is not read out as a number`() {
        // Cloudflare sits in front of the server, so its own 5xx reach the app.
        assertTrue((IvaClient.readAnswer(524, "") as Answer.Problem).message.contains("Telegram"))
        for (status in listOf(520, 521, 522, 523, 525, 526)) {
            val answer = IvaClient.readAnswer(status, "") as Answer.Problem
            assertTrue("status: $status", answer.message == "Iva non risponde.")
        }
    }

    @Test
    fun `every refusal the server can send says something out loud`() {
        for (status in listOf(400, 401, 409, 429, 502, 503, 504, 418)) {
            val answer = IvaClient.readAnswer(status, "")
            assertTrue("status: $status", answer is Answer.Problem)
            assertTrue("status: $status", (answer as Answer.Problem).message.isNotBlank())
        }
    }

    @Test
    fun `a busy server is distinguishable from a rejected token`() {
        assertTrue((IvaClient.readAnswer(409, "") as Answer.Problem).message.contains("aspetta"))
        assertTrue((IvaClient.readAnswer(401, "") as Answer.Problem).message.contains("Token"))
    }
}

class SpeechChunkTest {

    @Test
    fun `a short answer is spoken in one go`() {
        assertEquals(listOf("Ciao."), Speaker.chunk("  Ciao.  ", 100))
    }

    @Test
    fun `nothing to say produces nothing to speak`() {
        assertEquals(emptyList<String>(), Speaker.chunk("   ", 100))
    }

    @Test
    fun `a long answer is cut between sentences, not inside them`() {
        val text = "Prima frase. Seconda frase. Terza frase."
        val chunks = Speaker.chunk(text, 20)

        assertTrue(chunks.size > 1)
        chunks.forEach { assertTrue("chunk too long: $it", it.length <= 20) }
        // Nothing may be dropped: the speech engine silently truncates, this must not.
        assertEquals(
            text.replace(" ", ""),
            chunks.joinToString("").replace(" ", ""),
        )
    }

    @Test
    fun `a sentence longer than the engine allows is cut anyway`() {
        val chunks = Speaker.chunk("a".repeat(50), 20)
        assertEquals(3, chunks.size)
        chunks.forEach { assertTrue(it.length <= 20) }
        assertEquals("a".repeat(50), chunks.joinToString(""))
    }
}
